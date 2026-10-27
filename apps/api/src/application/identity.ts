import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  IdentityAuthenticationError, IdentityConflictError, IdentityInputError,
  IdentityRateLimitError, IdentityUnavailableError,
} from "../domain/errors.ts";
import { accessIssuerConfiguration, signAccessToken } from "../security/authentication.ts";
import { hashPassword, verifyPassword } from "../security/passwords.ts";

const REFRESH_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const WINDOW_SECONDS = 15 * 60;

type IdentitySession = {
  sessionId: string; userId: string; accessTokenId: string; refreshHash: string;
  expiresAt: string; accessExpiresAt: string;
};
type Rotation = { status: "invalid" | "reused" } | {
  status: "rotated"; userId: string; accessExpiresAt: string; refreshExpiresAt: string;
};
export type IdentityStore = {
  createIdentityAccount(input: { userId: string; email: string; passwordHash: string; session: IdentitySession }): Promise<boolean>;
  findIdentityAccount(input: { email: string }): Promise<{ userId: string; passwordHash: string } | null>;
  createIdentitySession(session: IdentitySession): Promise<unknown>;
  rotateIdentityRefresh(input: { refreshHash: string; nextRefreshHash: string; accessTokenId: string; issuedAt: string; accessExpiresAt: string }): Promise<Rotation>;
  revokeIdentityRefresh(input: { refreshHash: string }): Promise<unknown>;
  consumeIdentityRateLimit(input: { key: string; limit: number; windowSeconds: number }): Promise<{ allowed: boolean; resetAt: string }>;
  pruneExpiredIdentityState(): Promise<unknown>;
};

function configuration(env: NodeJS.ProcessEnv): ReturnType<typeof accessIssuerConfiguration> {
  try { return accessIssuerConfiguration(env); }
  catch { throw new IdentityUnavailableError(); }
}
function requireOnly(body: Record<string, unknown>, fields: readonly string[]): void {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) {
    throw new IdentityInputError();
  }
}
function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new IdentityInputError();
  const email = value.trim().toLowerCase();
  if (email.length > 254) throw new IdentityInputError();
  const parts = email.split("@");
  if (parts.length !== 2) throw new IdentityInputError();
  const [local, domain] = parts;
  const labels = domain.split(".");
  if (local.length < 1 || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..") || labels.length < 2 ||
      labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new IdentityInputError();
  }
  return email;
}
function passwordInput(value: unknown, registration: boolean): string {
  if (typeof value !== "string") throw new IdentityInputError();
  const length = Array.from(value).length;
  if (length < (registration ? 12 : 1) || length > 128 || Buffer.byteLength(value, "utf8") > 512) throw new IdentityInputError();
  return value;
}
function tokenInput(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new IdentityInputError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) throw new IdentityInputError();
  return value;
}
function refreshHash(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
function randomRefresh(): string { return randomBytes(32).toString("base64url"); }
function rateKey(secret: string, scope: string, subject: string): string {
  // Domain-separate throttle identifiers from JWT signatures even though both
  // are rooted in the server-only authentication secret.
  const key = createHmac("sha256", secret).update("bot-thk:identity-rate-limit:v1").digest();
  return createHmac("sha256", key).update(JSON.stringify([scope, subject])).digest("hex");
}
function timestamp(seconds: number): string { return new Date(seconds * 1000).toISOString(); }

/** Transport-independent registration, login, rotation and logout use cases. */
export function createIdentityService({ store, env }: { store: IdentityStore; env: NodeJS.ProcessEnv }) {
  let rateOperations = 0;
  async function consume(scope: string, subject: string, limit: number, windowSeconds: number, secret: string): Promise<void> {
    // Opportunistic bounded cleanup; no detached work can outlive the request.
    rateOperations += 1;
    if (rateOperations >= 128) {
      rateOperations = 0;
      await store.pruneExpiredIdentityState();
    }
    const result = await store.consumeIdentityRateLimit({ key: rateKey(secret, scope, subject), limit, windowSeconds });
    if (!result.allowed) {
      const wait = Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000);
      throw new IdentityRateLimitError(Number.isFinite(wait) ? Math.max(1, wait) : windowSeconds);
    }
  }
  async function limitPasswordRequest(action: "register" | "login", email: string, ip: string, secret: string): Promise<void> {
    const window = action === "register" ? 60 * 60 : WINDOW_SECONDS;
    await consume(`${action}:ip`, ip, action === "register" ? 20 : 60, window, secret);
    await consume(`${action}:email`, email, 5, window, secret);
  }
  async function limitTokenRequest(action: "refresh" | "logout", ip: string, secret: string): Promise<void> {
    await consume(`${action}:ip`, ip, 120, WINDOW_SECONDS, secret);
  }
  function prepareSession(userId: string, config: ReturnType<typeof accessIssuerConfiguration>): { refreshToken: string; issuedAt: number; session: IdentitySession } {
    const issuedAt = Math.floor(Date.now() / 1000);
    const refreshToken = randomRefresh();
    return {
      refreshToken,
      issuedAt,
      session: {
        sessionId: randomUUID(), userId, accessTokenId: randomUUID(), refreshHash: refreshHash(refreshToken),
        expiresAt: timestamp(issuedAt + REFRESH_LIFETIME_SECONDS),
        accessExpiresAt: timestamp(issuedAt + config.ttlSeconds),
      },
    };
  }
  function tokens({ userId, accessTokenId, issuedAt, accessExpiresAt, refreshExpiresAt, refreshToken }: {
    userId: string; accessTokenId: string; issuedAt: number; accessExpiresAt: string; refreshExpiresAt: string; refreshToken: string;
  }) {
    const expiresAt = Math.floor(new Date(accessExpiresAt).getTime() / 1000);
    return {
      accessToken: signAccessToken({ subject: userId, tokenId: accessTokenId, issuedAt, expiresAt, env }),
      tokenType: "Bearer",
      accessExpiresAt: timestamp(expiresAt),
      refreshToken,
      refreshExpiresAt: new Date(refreshExpiresAt).toISOString(),
    };
  }
  return Object.freeze({
    async register(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["email", "password"]);
      const email = normalizeEmail(body.email);
      const password = passwordInput(body.password, true);
      const config = configuration(env);
      await limitPasswordRequest("register", email, ip, config.secret);
      const passwordHash = await hashPassword(password);
      const userId = randomUUID();
      const prepared = prepareSession(userId, config);
      const response = tokens({ userId, accessTokenId: prepared.session.accessTokenId, issuedAt: prepared.issuedAt,
        accessExpiresAt: prepared.session.accessExpiresAt, refreshExpiresAt: prepared.session.expiresAt, refreshToken: prepared.refreshToken });
      const created = await store.createIdentityAccount({ userId, email, passwordHash, session: prepared.session });
      if (!created) throw new IdentityConflictError();
      return response;
    },
    async login(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["email", "password"]);
      const email = normalizeEmail(body.email);
      const password = passwordInput(body.password, false);
      const config = configuration(env);
      await limitPasswordRequest("login", email, ip, config.secret);
      const account = await store.findIdentityAccount({ email });
      const valid = await verifyPassword(password, account?.passwordHash ?? null);
      if (!account || !valid) throw new IdentityAuthenticationError();
      const prepared = prepareSession(account.userId, config);
      const response = tokens({ userId: account.userId, accessTokenId: prepared.session.accessTokenId, issuedAt: prepared.issuedAt,
        accessExpiresAt: prepared.session.accessExpiresAt, refreshExpiresAt: prepared.session.expiresAt, refreshToken: prepared.refreshToken });
      await store.createIdentitySession(prepared.session);
      return response;
    },
    async refresh(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["refreshToken"]);
      const token = tokenInput(body.refreshToken);
      const config = configuration(env);
      await limitTokenRequest("refresh", ip, config.secret);
      const issuedAt = Math.floor(Date.now() / 1000);
      const nextRefresh = randomRefresh();
      const accessTokenId = randomUUID();
      const result = await store.rotateIdentityRefresh({ refreshHash: refreshHash(token), nextRefreshHash: refreshHash(nextRefresh),
        accessTokenId, issuedAt: timestamp(issuedAt), accessExpiresAt: timestamp(issuedAt + config.ttlSeconds) });
      if (result.status !== "rotated") throw new IdentityAuthenticationError();
      return tokens({ userId: result.userId, accessTokenId, issuedAt, accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt, refreshToken: nextRefresh });
    },
    async logout(body: Record<string, unknown>, ip: string) {
      requireOnly(body, ["refreshToken"]);
      const token = tokenInput(body.refreshToken);
      const config = configuration(env);
      await limitTokenRequest("logout", ip, config.secret);
      await store.revokeIdentityRefresh({ refreshHash: refreshHash(token) });
      return { ok: true };
    },
  });
}
