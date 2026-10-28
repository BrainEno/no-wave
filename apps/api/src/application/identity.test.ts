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
