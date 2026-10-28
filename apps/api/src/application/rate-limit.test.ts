import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimitService, resolveWriteRateLimitPolicy } from "./rate-limit.ts";

const env = { AUTH_JWT_SECRET: "rate-limit-test-secret-with-at-least-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" };

test("write limits use canonical endpoint names and never key individual resource slugs", () => {
  assert.deepEqual(resolveWriteRateLimitPolicy("POST", "/api/v1/articles"), {
    endpoint: "article.create", windowSeconds: 3600, ipLimit: 30, userLimit: 10,
  });
  assert.deepEqual(
    resolveWriteRateLimitPolicy("PUT", "/api/v1/articles/slug-one"),
    resolveWriteRateLimitPolicy("PUT", "/api/v1/articles/slug-two"),
  );
  assert.equal(resolveWriteRateLimitPolicy("POST", "/api/v1/auth/login"), null);
  assert.equal(resolveWriteRateLimitPolicy("GET", "/api/v1/articles"), null);
  assert.equal(resolveWriteRateLimitPolicy("POST", "/api/v1/conversations/conversation-1/messages")?.endpoint, "message.send");
});

test("write limiter charges user and IP buckets with opaque, separate keys", async () => {
  const calls = [];
  const service = createRateLimitService({
    env,
    store: {
      async consumeRateLimit(input) {
        calls.push(input);
        return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() };
      },
    },
  });
  await service.checkWrite({ method: "POST", pathname: "/api/v1/articles", ip: "192.0.2.10", actorId: "writer-123" });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => /^[a-f0-9]{64}$/.test(call.key)));
  assert.equal(new Set(calls.map((call) => call.key)).size, 2);
  assert.ok(calls.every((call) => !call.key.includes("192.0.2.10") && !call.key.includes("writer-123")));
  assert.deepEqual(calls.map((call) => call.limit), [10, 30]);
  assert.deepEqual(calls.map((call) => call.windowSeconds), [3600, 3600]);
});

test("anonymous write attempts still consume an IP bucket", async () => {
  const calls = [];
  const service = createRateLimitService({
    env,
    store: {
      async consumeRateLimit(input) {
        calls.push(input);
        return { allowed: true, resetAt: new Date(Date.now() + 60000).toISOString() };
      },
    },
  });
  await service.checkWrite({ method: "POST", pathname: "/api/v1/articles/hello-world/comments", ip: "192.0.2.10", actorId: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 60);
  assert.equal(calls[0].windowSeconds, 60);
});

test("a blocked user is rejected before consuming the shared IP bucket", async () => {
  const calls = [];
  const resetAt = new Date(Date.now() + 3200).toISOString();
  const service = createRateLimitService({
    env,
    store: {
      async consumeRateLimit(input) {
        calls.push(input);
        return { allowed: false, resetAt };
      },
    },
  });
  await assert.rejects(
    service.checkWrite({ method: "POST", pathname: "/api/v1/articles", ip: "192.0.2.10", actorId: "writer-123" }),
    (error) => error.code === "RATE_LIMITED" && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 4,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 10);
});

test("write limits are not applied when authentication cannot be configured", async () => {
  let calls = 0;
  const service = createRateLimitService({
    env: { AUTH_JWT_SECRET: "short" },
    store: { async consumeRateLimit() { calls += 1; return { allowed: true, resetAt: new Date().toISOString() }; } },
  });
  await service.checkWrite({ method: "POST", pathname: "/api/v1/articles", ip: "unknown", actorId: null });
  assert.equal(calls, 0);
});
