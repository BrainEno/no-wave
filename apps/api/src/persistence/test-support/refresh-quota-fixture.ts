import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createIdentityService } from "../../application/identity.ts";
import { hashPassword } from "../../security/passwords.ts";
import { createPostgresStore } from "../postgres.ts";
import type { PgDatabase } from "../postgres-driver.ts";
import { createSqliteClient, runSqliteMigrations } from "../sqlite.ts";
import { createSqliteStore } from "../sqlite-store.ts";
import { createIsolatedPostgresTestSchema } from "./isolated-postgres-schema.ts";

export const refreshDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function createRefreshQuotaFixture(provider: "sqlite" | "postgres", databaseUrl = process.env.TEST_DATABASE_URL) {
  const db = provider === "sqlite" ? createSqliteClient({ filename: ":memory:", enableWal: false }) : null;
  let sql: PgDatabase | null = null, cleanup = async () => { db?.close(); };
  if (db) await runSqliteMigrations(db);
  else {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for real PostgreSQL refresh tests.");
    const isolated = await createIsolatedPostgresTestSchema(databaseUrl);
    sql = isolated.sql;
    cleanup = isolated.cleanup;
  }
  const store = db ? createSqliteStore(db) : createPostgresStore(sql!);
  const env = { AUTH_JWT_SECRET: `fixture-quota-${randomBytes(32).toString("hex")}`, AUTH_JWT_ISSUER: "https://refresh.fixture.test", AUTH_JWT_AUDIENCE: "refresh-fixture" };
  const userId = randomUUID(), email = `${userId}@example.test`, password = "Disposable refresh fixture 4826!";
  const proof = { email, passwordHash: await hashPassword(password) };
  const newSession = () => {
    const refreshToken = randomBytes(32).toString("base64url");
    return { sessionId: randomUUID(), userId, accessTokenId: randomUUID(), refreshHash: refreshDigest(refreshToken), refreshToken,
      accessExpiresAt: new Date(Date.now() + 300_000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() };
  };
  const initial = newSession();
  assert.equal(await store.createIdentityAccount({ userId, ...proof, session: initial }), true);
  async function seedSession() { const session = newSession(); assert.equal(await store.createIdentitySession(session, proof), true); return session; }
  async function query<T extends Record<string, unknown>>(sqlite: string, postgres: string, values: readonly (string | number)[] = []): Promise<T[]> {
    // postgres.js returns a Result subclass; expose one provider-neutral row list.
    return db ? db.prepare(sqlite).all(...values) as T[] : Array.from(await sql!.unsafe<T>(postgres, values));
  }
  function rateKey(scope: string, subject: string) {
    const key = createHmac("sha256", env.AUTH_JWT_SECRET).update("bot-thk:identity-rate-limit:v1").digest();
    return createHmac("sha256", key).update(JSON.stringify([scope, subject])).digest("hex");
  }
  return { db, sql, store, env, initial, userId, email, password, proof, seedSession, query, rateKey, cleanup,
    service: createIdentityService({ store, env }),
    async buckets() { return query<{ key: string; attempts: number; reset_at: string | Date }>("SELECT key, attempts, reset_at FROM auth_rate_limits ORDER BY key", "SELECT key, attempts, reset_at FROM auth_rate_limits ORDER BY key"); },
    async refreshRows(sessionId = initial.sessionId) { return query<{ token_hash: string; used_at: string | Date | null }>("SELECT token_hash, used_at FROM auth_refresh_tokens WHERE session_id = ? ORDER BY token_hash", "SELECT token_hash, used_at FROM auth_refresh_tokens WHERE session_id = $1 ORDER BY token_hash", [sessionId]); },
    async expireSession(sessionId = initial.sessionId) {
      if (db) db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", sessionId);
      else await sql!.unsafe("UPDATE auth_sessions SET expires_at = $1 WHERE id = $2", ["2000-01-01T00:00:00.000Z", sessionId]);
    },
    async expireBuckets() {
      if (db) db.prepare("UPDATE auth_rate_limits SET reset_at = ?").run("2000-01-01T00:00:00.000Z");
      else await sql!.unsafe("UPDATE auth_rate_limits SET reset_at = $1", ["2000-01-01T00:00:00.000Z"]);
    },
  };
}
