import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createIdentityService } from "./identity.ts";

test("identity maintenance is periodically invoked without exposing throttle subjects", async () => {
  const keys = [];
  let cleanups = 0;
  const service = createIdentityService({
    env: { AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" },
    store: {
      async consumeRateLimit({ key }) { keys.push(key); return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() }; },
      async revokeIdentityRefresh() { return true; },
      async pruneExpiredIdentityState() { cleanups += 1; },
    },
  });
  const refreshToken = randomBytes(32).toString("base64url");
  for (let i = 0; i < 128; i += 1) await service.logout({ refreshToken }, "192.0.2.123");
  assert.equal(cleanups, 1);
  assert.equal(keys.length, 128);
  assert.ok(keys.every((key) => /^[0-9a-f]{64}$/.test(key)));
  assert.equal(new Set(keys).size, 1);
  assert.ok(!keys.some((key) => key.includes("192.0.2.123")));
});

/**
 * The registration throttle's address limit.
 *
 * The default is a production abuse control and must not move: registration is
 * the only unauthenticated write that creates rows, and behind the Web proxy
 * every browser shares an address. What is asserted here is that the number the
 * limiter sees is that default unless the operator names another one, and that a
 * value which cannot be read as a limit cannot quietly switch the throttle off.
 */
async function registerLimitSeenByTheThrottle(env: Record<string, string>): Promise<number> {
  const limits: number[] = [];
  const service = createIdentityService({
    env: { AUTH_JWT_SECRET: "fixture-secret-not-a-real-key-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test", ...env },
    store: {
      async consumeRateLimit({ limit }) { limits.push(limit); return { allowed: true, resetAt: new Date(Date.now() + 60_000).toISOString() }; },
      async createIdentityAccount() { return true; },
      async findIdentityAccount() { return null; },
      async createIdentitySession() { return true; },
      async revokeIdentityRefresh() { return true; },
      async pruneExpiredIdentityState() { return true; },
    },
  });
  await service.register({ email: `throttle-${Date.now().toString(36)}@example.test`, password: "e2e-browser-password" }, "192.0.2.123");
  // The address bucket is charged first, then the address's own email bucket.
  return { ip: limits[0] ?? -1, email: limits[1] ?? -1 };
}

test("the registration throttle keeps its default, and only the operator can widen it", async () => {
  const defaulted = await registerLimitSeenByTheThrottle({});
  assert.equal(defaulted.ip, 20, "the default is unchanged");
  assert.equal(defaulted.email, 5, "the per-address email throttle is unchanged too");
  assert.equal((await registerLimitSeenByTheThrottle({ AUTH_REGISTER_IP_LIMIT: "40" })).ip, 40, "a configured limit is honoured");

  // A limit that does not parse — or that would disable the throttle — falls
  // back to the default instead of leaving registration open.
  for (const unusable of ["0", "-3", "unlimited", "   "]) {
    assert.equal(
      (await registerLimitSeenByTheThrottle({ AUTH_REGISTER_IP_LIMIT: unusable })).ip,
      20,
      `"${unusable}" must not be read as a limit`,
    );
  }
});
