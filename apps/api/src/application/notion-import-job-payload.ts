import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope for an eventual durable job input. This module does not persist,
 * schedule, expire or delete anything, and must not be used for Notion tokens.
 * Its plaintext may include expiring signed image URLs and is therefore secret.
 */
export const MAX_NOTION_JOB_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_NOTION_JOB_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

type Context = { jobId: string; ownerId: string; expiresAt: number };
export type EncryptedNotionJobPayload = Context & {
  version: 1;
  nonce: string;
  ciphertext: string;
  tag: string;
};

function validContext(context: Context): boolean {
  return typeof context.jobId === "string" && context.jobId.length > 0 && context.jobId.length <= 200 &&
    typeof context.ownerId === "string" && context.ownerId.length > 0 && context.ownerId.length <= 200 &&
    Number.isSafeInteger(context.expiresAt) && context.expiresAt > 0;
}

function aad(context: Context): Buffer {
  // JSON array gives each field an unambiguous boundary, including arbitrary IDs.
  return Buffer.from(JSON.stringify(["notion-import-job", 1, context.jobId, context.ownerId, context.expiresAt]), "utf8");
}

/** Reject non-canonical base64; Node's Buffer decoder otherwise ignores invalid characters. */
function decode(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid encrypted job payload");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) throw new Error("Invalid encrypted job payload");
  return bytes;
}

/** Key material must be generated and managed outside the database. */
export function createNotionJobPayloadCipher(key: Uint8Array) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("Notion job payload key must be 32 bytes");
  const secret = Buffer.from(key);
  return Object.freeze({
    seal(plaintext: Uint8Array, context: Context, now: number): EncryptedNotionJobPayload {
      if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > MAX_NOTION_JOB_PAYLOAD_BYTES ||
          !validContext(context) || !Number.isSafeInteger(now) || context.expiresAt <= now ||
          context.expiresAt - now > MAX_NOTION_JOB_PAYLOAD_TTL_MS) throw new Error("Invalid job payload or expiry");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, nonce);
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { jobId: context.jobId, ownerId: context.ownerId, expiresAt: context.expiresAt, version: 1, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    },
    open(envelope: EncryptedNotionJobPayload, expected: { jobId: string; ownerId: string }, now: number): Buffer {
      // Collapse authentication and parsing errors; never echo input or cipher errors.
      try {
        if (!envelope || envelope.version !== 1 || !validContext(envelope) || !Number.isSafeInteger(now) ||
            envelope.expiresAt <= now || envelope.jobId !== expected.jobId || envelope.ownerId !== expected.ownerId) throw new Error();
        const nonce = decode(envelope.nonce, 12);
        const tag = decode(envelope.tag, 16);
        const ciphertext = decode(envelope.ciphertext, MAX_NOTION_JOB_PAYLOAD_BYTES);
        if (nonce.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", secret, nonce);
        decipher.setAAD(aad(envelope));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new Error("Encrypted job payload unavailable or invalid");
      }
    },
  });
}
