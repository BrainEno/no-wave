import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimitService, IDENTITY_THROTTLED_ROUTE_IDS, resolveWriteRateLimitPolicy } from "./rate-limit.ts";
import { REST_ROUTES } from "../transport/rest/routes.ts";

const env = { AUTH_JWT_SECRET: "rate-limit-test-secret-with-at-least-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" };

/**
 * The route table and this module's endpoint list are two separate lists, and
 * nothing but a test can keep them honest: five write routes (article delete and
 * restore, media delete, the featured shelf and role assignment) shipped with no
 * policy at all because adding a route did not require touching this file.
 *
 * A route id is exempt only when the identity service throttles it, and the
 * exemption list is checked for staleness in the same test — otherwise "handled
 * elsewhere" and "forgotten" are the same silence.
 */
test("every write route is either throttled here or explicitly throttled by the identity service", () => {
  const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const placeholder = "00000000-0000-4000-8000-000000000000";
  const knownIds = new Set(REST_ROUTES.map((route) => route.id));

  for (const id of IDENTITY_THROTTLED_ROUTE_IDS) {
    assert.ok(knownIds.has(id), `IDENTITY_THROTTLED_ROUTE_IDS names "${id}", which is not a route id`);
  }

  const unthrottled = [];
  const exempt = [];
  for (const route of REST_ROUTES) {
    const pathname = "/api/v1/" + route.segments
      .map((segment) => (segment.kind === "literal" ? segment.value : (segment.values?.[0] ?? placeholder)))
      .join("/");
    for (const method of route.methods) {
      if (!writeMethods.has(method)) continue;
      if (resolveWriteRateLimitPolicy(method, pathname)) continue;
      if (IDENTITY_THROTTLED_ROUTE_IDS.includes(route.id)) exempt.push(`${method} ${pathname}`);
      else unthrottled.push(`${method} ${pathname}   [${route.id}]`);
    }
  }

  assert.deepEqual(unthrottled, [], "write routes with neither a generic policy nor an identity-service throttle");
  assert.ok(exempt.length > 0, "the exemption list should describe routes that exist");
});

test("resource ids never become rate limit keys, but each write route gets its own bucket", () => {
  assert.equal(resolveWriteRateLimitPolicy("DELETE", "/api/v1/articles/one")?.endpoint, "article.delete");
  assert.equal(
    resolveWriteRateLimitPolicy("DELETE", "/api/v1/articles/one")?.endpoint,
    resolveWriteRateLimitPolicy("DELETE", "/api/v1/articles/two")?.endpoint,
  );
  assert.equal(resolveWriteRateLimitPolicy("POST", "/api/v1/articles/one/restore")?.endpoint, "article.restore");
  assert.equal(resolveWriteRateLimitPolicy("DELETE", "/api/v1/me/media/media-1")?.endpoint, "media.delete");
  assert.equal(resolveWriteRateLimitPolicy("PUT", "/api/v1/featured")?.endpoint, "featured.set");
  assert.equal(resolveWriteRateLimitPolicy("PUT", "/api/v1/users/user-1/role")?.endpoint, "user.role.set");
  // A restore is not an update: the two share a path prefix and must not share a bucket.
  assert.notEqual(
    resolveWriteRateLimitPolicy("PUT", "/api/v1/articles/one")?.endpoint,
    resolveWriteRateLimitPolicy("POST", "/api/v1/articles/one/restore")?.endpoint,
  );
});

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
