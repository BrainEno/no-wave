import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isTokenEnvelope } from "@bot-thk/web-http/policy";
import { isRecord, type RefreshFailure, type RefreshOutcome } from "@bot-thk/web-http";
import { RefreshCoordinationError } from "./errors.ts";

export type RefreshResultBinding = Readonly<{ namespace: string; key: string; owner: string; expiresAt: string }>;
const MAX_PLAINTEXT_BYTES = 16_384;
const MAX_SEALED_LENGTH = 22_000;

function invalidResult(): never { throw new RefreshCoordinationError("invalid-result"); }


/** Store only the protocol's whitelist, not arbitrary upstream JSON/headers. */
export function normalizeRefreshOutcome(value: unknown): RefreshOutcome {
  if (value === undefined || value === null) return value;
  if (!isRecord(value)) return invalidResult();
  if (value.kind === "failed") {
    if (!Number.isInteger(value.status) || Number(value.status) < 400 || Number(value.status) > 599 ||
        typeof value.code !== "string" || !/^[A-Z0-9_]{1,80}$/.test(value.code) ||
        typeof value.message !== "string" || value.message.length > 240 ||
        (value.retryAfterSeconds !== null && (!Number.isInteger(value.retryAfterSeconds) || Number(value.retryAfterSeconds) < 1 || Number(value.retryAfterSeconds) > 86400))) return invalidResult();
    return { kind: "failed", status: Number(value.status), code: value.code, message: value.message, retryAfterSeconds: value.retryAfterSeconds as number | null };
  }
  const data = { data: value };
  if (!isTokenEnvelope(data) || data.data.accessToken.length > 8192) return invalidResult();
  const accessExpiresAt = new Date(data.data.accessExpiresAt).toISOString();
  const refreshExpiresAt = new Date(data.data.refreshExpiresAt).toISOString();
  if (Date.parse(refreshExpiresAt) < Date.parse(accessExpiresAt)) return invalidResult();
  return { accessToken: data.data.accessToken, tokenType: "Bearer", accessExpiresAt,
    refreshToken: data.data.refreshToken, refreshExpiresAt };
}

export function isUncertainRefreshOutcome(value: RefreshOutcome): boolean {
  if (value === undefined) return true;
  return value !== null && "kind" in value && value.kind === "failed" && value.status >= 500;
}

export function isTransientRefreshOutcome(value: RefreshOutcome): value is RefreshFailure {
  return value !== null && value !== undefined && "kind" in value && value.kind === "failed" && value.status !== 400 && value.status !== 401;
}

/** AES-256-GCM with a fresh nonce and authenticated row identity/expiry. */
export class RefreshResultCodec {
  private readonly key: Buffer;
  readonly fingerprint: string;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new RefreshCoordinationError("invalid-result");
    this.key = Buffer.from(key);
    this.fingerprint = createHash("sha256").update("no-wave/shared-refresh/key/v1\0").update(this.key).digest("hex");
  }

  private additionalData(binding: RefreshResultBinding): Buffer {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(binding.namespace) || !/^[a-f0-9]{64}$/.test(binding.key) ||
        !/^[a-f0-9-]{36}$/.test(binding.owner) || !Number.isFinite(Date.parse(binding.expiresAt))) return invalidResult();
    return Buffer.from(JSON.stringify(["no-wave/shared-refresh/result/v1", binding.namespace, binding.key, binding.owner, binding.expiresAt]), "utf8");
  }

  seal(value: unknown, binding: RefreshResultBinding): string {
    const outcome = normalizeRefreshOutcome(value);
    const body = Buffer.from(JSON.stringify({ v: 1, type: outcome === undefined ? "uncertain" : "value", value: outcome }), "utf8");
    if (body.byteLength > MAX_PLAINTEXT_BYTES) return invalidResult();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.additionalData(binding));
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    return "v1." + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  open(sealed: string, binding: RefreshResultBinding): RefreshOutcome {
    try {
      if (typeof sealed !== "string" || sealed.length > MAX_SEALED_LENGTH || !/^v1\.[A-Za-z0-9_-]+$/.test(sealed)) return invalidResult();
      const encoded = sealed.slice(3);
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength < 29 || bytes.toString("base64url") !== encoded) return invalidResult();
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(this.additionalData(binding));
      const body = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      if (body.byteLength > MAX_PLAINTEXT_BYTES) return invalidResult();
      const envelope: unknown = JSON.parse(body.toString("utf8"));
      if (!isRecord(envelope) || envelope.v !== 1) return invalidResult();
      if (envelope.type === "uncertain" && envelope.value === undefined) return undefined;
      if (envelope.type !== "value" || !("value" in envelope)) return invalidResult();
      return normalizeRefreshOutcome(envelope.value);
    } catch { return invalidResult(); }
  }

  dispose(): void { this.key.fill(0); }
}
