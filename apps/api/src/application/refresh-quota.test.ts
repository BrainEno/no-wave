import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { createIdentityService, type IdentityStore } from "./identity.ts";
import { IdentityAuthenticationError, IdentityInputError, IdentityRateLimitError } from "../domain/errors.ts";

const env = { AUTH_JWT_SECRET: "fixture-refresh-quota-key-not-a-real-secret", AUTH_JWT_ISSUER: "fixture", AUTH_JWT_AUDIENCE: "fixture" };
const token = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function rateKey(scope: string, subject: string) {
  const secret = createHmac("sha256", env.AUTH_JWT_SECRET).update("bot-thk:identity-rate-limit:v1").digest();
  return createHmac("sha256", secret).update(JSON.stringify([scope, subject])).digest("hex");
}
function fixture() {
  const known = new Map<string, { sessionId: string; userId: string }>();
  const buckets = new Map<string, number>();
  const charges: { key: string; limit: number; windowSeconds: number }[] = [];
  const lookups: string[] = [], rotations: string[] = [];
  const store = {
    async findIdentityRefreshSession({ refreshHash }: { refreshHash: string }) { lookups.push(refreshHash); return known.get(refreshHash) ?? null; },
    async consumeRateLimit(input: { key: string; limit: number; windowSeconds: number }) {
      charges.push(input);
      const count = (buckets.get(input.key) ?? 0) + 1;
      buckets.set(input.key, count);
      return { allowed: count <= input.limit, resetAt: new Date(Date.now() + 900_000).toISOString() };
    },
    async rotateIdentityRefresh({ refreshHash }: { refreshHash: string }) {
      rotations.push(refreshHash);
      const owner = known.get(refreshHash);
      return owner ? { status: "rotated" as const, ...owner, accessExpiresAt: new Date(Date.now() + 60_000).toISOString(), refreshExpiresAt: new Date(Date.now() + 86400_000).toISOString() } : { status: "invalid" as const };
    },
    async pruneExpiredIdentityState() {},
  };
  const service = createIdentityService({ store: store as unknown as IdentityStore, env });
  return { known, buckets, charges, lookups, rotations, store, service };
}

test("refresh quota authority is the database's session, not source IP or refresh-token generation", async () => {
  const f = fixture(), first = token(), nextGeneration = token();
  f.known.set(digest(first), { sessionId: "stable-session", userId: "owner" });
  f.known.set(digest(nextGeneration), { sessionId: "stable-session", userId: "owner" });
  await f.service.refresh({ refreshToken: first }, "192.0.2.1");
  await f.service.refresh({ refreshToken: nextGeneration }, "198.51.100.9");
  assert.deepEqual(f.lookups, [digest(first), digest(nextGeneration)]);
  assert.deepEqual(f.rotations, f.lookups);
  assert.equal(f.charges.length, 2);
  assert.ok(f.charges.every((charge) => charge.key === rateKey("refresh:session", "stable-session")));
  assert.ok(f.charges.every(({ limit, windowSeconds }) => limit === 120 && windowSeconds === 900));
  assert.equal(f.buckets.size, 1);
  assert.equal(f.charges.some(({ key }) => key.includes(first) || key.includes("stable-session") || key.includes("192.0.2.1")), false);
});

test("unrelated sessions of one account sharing a NAT do not share a refresh budget", async () => {
  const f = fixture(), first = token(), second = token();
  f.known.set(digest(first), { sessionId: "laptop", userId: "same-owner" });
  f.known.set(digest(second), { sessionId: "phone", userId: "same-owner" });
  f.buckets.set(rateKey("refresh:session", "laptop"), 120);
  await assert.rejects(f.service.refresh({ refreshToken: first }, "192.0.2.7"), IdentityRateLimitError);
  const rotated = await f.service.refresh({ refreshToken: second }, "192.0.2.7");
  assert.equal(rotated.tokenType, "Bearer");
  assert.equal(f.charges[0]!.key, rateKey("refresh:session", "laptop"));
  assert.equal(f.charges[1]!.key, rateKey("refresh:session", "phone"));
  assert.deepEqual(f.rotations, [digest(second)]);
  assert.equal(f.charges.length, 2);
});

test("changing IP cannot reset an exhausted stable session and quota refusal never rotates it", async () => {
  const f = fixture(), credential = token();
  f.known.set(digest(credential), { sessionId: "exhausted-device", userId: "owner" });
  f.buckets.set(rateKey("refresh:session", "exhausted-device"), 120);
  for (const ip of ["192.0.2.1", "192.0.2.2", "2001:db8::1"]) {
    await assert.rejects(f.service.refresh({ refreshToken: credential }, ip), (error: unknown) => {
      assert.ok(error instanceof IdentityRateLimitError);
      assert.ok(error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 900);
      return true;
    });
  }
  assert.equal(f.lookups.length, 3);
  assert.equal(new Set(f.charges.map(({ key }) => key)).size, 1);
  assert.deepEqual(f.rotations, []);
});

test("unknown canonical tokens retain a bounded IP budget that cannot be reset by token spraying", async () => {
  const f = fixture();
  f.buckets.set(rateKey("refresh:ip", "192.0.2.8"), 119);
  await assert.rejects(f.service.refresh({ refreshToken: token() }, "192.0.2.8"), IdentityAuthenticationError);
  await assert.rejects(f.service.refresh({ refreshToken: token() }, "192.0.2.8"), IdentityRateLimitError);
  await assert.rejects(f.service.refresh({ refreshToken: token() }, "192.0.2.9"), IdentityAuthenticationError);
  assert.equal(f.charges[0]!.key, f.charges[1]!.key);
  assert.notEqual(f.charges[1]!.key, f.charges[2]!.key);
  assert.ok(f.charges.every(({ limit, windowSeconds }) => limit === 120 && windowSeconds === 900));
  assert.equal(f.rotations.length, 2);
  assert.equal(f.buckets.size, 2, "untrusted random tokens never allocate one rate row per token");
});

test("an exhausted unknown-token NAT bucket cannot lock out a database-confirmed live session", async () => {
  const f = fixture(), credential = token();
  f.buckets.set(rateKey("refresh:ip", "192.0.2.7"), 120);
  f.known.set(digest(credential), { sessionId: "live-device", userId: "owner" });
  const result = await f.service.refresh({ refreshToken: credential }, "192.0.2.7");
  assert.equal(result.tokenType, "Bearer");
  assert.equal(f.charges.length, 1);
  assert.equal(f.charges[0]!.key, rateKey("refresh:session", "live-device"));
  assert.equal(f.buckets.get(rateKey("refresh:ip", "192.0.2.7")), 120);
  assert.deepEqual(f.rotations, [digest(credential)]);
});

test("browser-supplied session or user ids cannot select the quota and malformed credentials spend nothing", async () => {
  const f = fixture(), credential = token();
  for (const body of [{ refreshToken: credential, sessionId: "other-device" }, { refreshToken: credential, userId: "other-user" }, { refreshToken: "short" }, { refreshToken: "A".repeat(42) + "B" }, {}]) {
    await assert.rejects(f.service.refresh(body, "192.0.2.7"), IdentityInputError);
  }
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.charges, []);
  assert.deepEqual(f.rotations, []);
});

test("failure to resolve the trusted session fails closed instead of falling back to an arbitrary quota", async () => {
  const f = fixture(), credential = token();
  const store = { ...f.store, async findIdentityRefreshSession() { throw new Error("fixture database lookup failed"); } };
  const service = createIdentityService({ store: store as unknown as IdentityStore, env });
  await assert.rejects(service.refresh({ refreshToken: credential }, "192.0.2.7"), /lookup failed/);
  assert.deepEqual(f.charges, []);
  assert.deepEqual(f.rotations, []);
});

test("session lookup is quota metadata, never a replacement for atomic rotation authentication", async () => {
  const f = fixture(), credential = token();
  f.known.set(digest(credential), { sessionId: "revoked-during-request", userId: "owner" });
  let attempts = 0;
  const service = createIdentityService({ env, store: { ...f.store, async rotateIdentityRefresh() { attempts++; return { status: "invalid" }; } } as unknown as IdentityStore });
  await assert.rejects(service.refresh({ refreshToken: credential }, "192.0.2.7"), IdentityAuthenticationError);
  assert.equal(attempts, 1);
  assert.equal(f.charges[0]!.key, rateKey("refresh:session", "revoked-during-request"));
  assert.equal(f.charges.length, 1);
});
