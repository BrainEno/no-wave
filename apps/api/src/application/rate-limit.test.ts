import assert from "node:assert/strict";
import test from "node:test";
import {
  IDENTITY_THROTTLED_ROUTE_IDS,
  assertWriteRateLimitsCoverRoutes,
  createRateLimitService,
  resolveWriteRateLimitPolicy,
  type WriteRateLimitPolicy,
} from "./rate-limit.ts";
import { REST_ROUTES } from "../transport/rest/routes.ts";

const env = { AUTH_JWT_SECRET: "rate-limit-test-secret-with-at-least-32-bytes", AUTH_JWT_ISSUER: "test", AUTH_JWT_AUDIENCE: "test" };

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The policy for a route, asserting it exists so the tests read as plain values. */
function policyFor(method: string, routeId: string): WriteRateLimitPolicy {
  const policy = resolveWriteRateLimitPolicy(method, routeId);
  assert.ok(policy, `${method} ${routeId} must have a policy`);
  return policy;
}

/**
 * The limits used to be resolved from a hand-written list of path regexes, a
 * second route table that nothing could keep honest: a renamed path silently
 * stopped being throttled, and a policy name that did not exist silently fell
 * back to the generic limits. Five write routes shipped with no policy at all
 * before a test noticed.
 *
 * Resolution is now keyed by the route table's own ids, the table is total, and
 * this is the assertion that says so in both directions: every mutating route has
 * a policy or an exemption, and no entry describes a route that does not exist.
 */
test("the policy table and the route table are the same table", () => {
  assert.doesNotThrow(() => assertWriteRateLimitsCoverRoutes(REST_ROUTES));

  const covered: string[] = [];
  for (const route of REST_ROUTES) {
    for (const method of route.methods) {
      if (!WRITE_METHODS.has(method)) continue;
      const policy = resolveWriteRateLimitPolicy(method, route.id);
      if (IDENTITY_THROTTLED_ROUTE_IDS.includes(route.id)) {
        assert.equal(policy, null, `${method} ${route.id} is throttled by the identity service and must not be throttled twice`);
        continue;
      }
      assert.ok(policy, `${method} ${route.id} has neither a generic policy nor an exemption`);
      covered.push(`${method} ${route.id}`);
    }
  }
  assert.ok(covered.length > 20, `expected the write surface to be covered, saw ${covered.length} routes`);
});

test("the boot-time validator refuses a table that has drifted", () => {
  const routes = [
    { id: "articles", methods: ["GET", "POST"] },
    { id: "articles.item", methods: ["GET", "PUT", "DELETE"] },
  ];

  // A route that lost its policy: the exact failure the old path list made
  // invisible.
  assert.throws(
    () => assertWriteRateLimitsCoverRoutes([...routes, { id: "brand.new", methods: ["POST"] }]),
    /POST brand\.new/,
    "a mutating route with no policy must fail at boot, not go unthrottled",
  );

  // A policy for a route that no longer exists — a rename, or a route deleted
  // without its entry.
  assert.throws(
    () => assertWriteRateLimitsCoverRoutes([{ id: "articles", methods: ["GET", "POST"] }]),
    /articles\.item/,
    "an entry for a nonexistent route is stale and must fail",
  );

  // An exemption for a route that does not exist, or one that stopped being a
  // mutation, is the same silence as a missing policy.
  assert.throws(
    () => assertWriteRateLimitsCoverRoutes([...REST_ROUTES, { id: "ghost.route", methods: ["POST"] }]),
    /ghost\.route/,
    "an unlisted mutating route must fail even when the rest is consistent",
  );
  assert.throws(
    () => assertWriteRateLimitsCoverRoutes(REST_ROUTES.filter((route) => route.id !== "me.session")),
    /me\.session/,
    "a policy for a route that no longer exists must fail",
  );
});

test("an unknown route id is never silently throttled by a generic policy", () => {
  // The old resolver answered with DEFAULT_POLICY for any path it recognised and
  // null for the rest, so a typo in an endpoint name became "use the default".
  // There is no default now: a route either has a policy or it does not.
  assert.equal(resolveWriteRateLimitPolicy("POST", "no.such.route"), null);
  assert.equal(resolveWriteRateLimitPolicy("POST", ""), null);
  assert.equal(resolveWriteRateLimitPolicy("GET", "articles"), null, "reads are not throttled here");
  assert.equal(resolveWriteRateLimitPolicy("GET", "articles.item"), null);
  assert.equal(resolveWriteRateLimitPolicy("POST", "auth"), null, "identity routes keep their own limiter");
});

test("resource ids never become rate limit keys, and every write route has its own bucket", () => {
  // A route id, not a path: the bucket cannot depend on which slug was written.
  assert.equal(policyFor("PUT", "articles.item").endpoint, "article.update");
  assert.equal(policyFor("DELETE", "articles.item").endpoint, "article.delete");
  assert.equal(policyFor("POST", "articles.restore").endpoint, "article.restore");
  assert.equal(policyFor("DELETE", "me.media.item").endpoint, "media.delete");
  assert.equal(policyFor("PUT", "featured").endpoint, "featured.set");
  assert.equal(policyFor("PUT", "users.role").endpoint, "user.role.set");
  assert.equal(policyFor("POST", "users.follow").endpoint, "user.follow");
  assert.equal(policyFor("DELETE", "users.follow").endpoint, "user.unfollow");
  // A restore is not an update: sharing a route prefix must not share a bucket.
  assert.notEqual(
    policyFor("PUT", "articles.item").endpoint,
    policyFor("POST", "articles.restore").endpoint,
  );
  // One collection route can be two operations, and the two keep their own names.
  assert.notEqual(
    policyFor("POST", "users.follow").endpoint,
    policyFor("DELETE", "users.follow").endpoint,
  );
  // Two paths that are one operation keep one bucket.
  assert.equal(policyFor("POST", "tags").endpoint, policyFor("POST", "taxonomies").endpoint);
});

test("the documented limits are what the table actually enforces", () => {
  // ADR 0011's table, route by route. A refactor must not quietly loosen a limit
  // while keeping the shape of the policy.
  assert.deepEqual(policyFor("POST", "articles"), {
    endpoint: "article.create", windowSeconds: 3600, ipLimit: 30, userLimit: 10,
  });
  assert.deepEqual(policyFor("PUT", "articles.item"), {
    endpoint: "article.update", windowSeconds: 3600, ipLimit: 60, userLimit: 20,
  });
  assert.deepEqual(policyFor("PUT", "me.profile"), {
    endpoint: "profile.update", windowSeconds: 3600, ipLimit: 60, userLimit: 20,
  });
  assert.deepEqual(policyFor("POST", "articles.comments"), {
    endpoint: "comment.create", windowSeconds: 60, ipLimit: 60, userLimit: 20,
  });
  assert.deepEqual(policyFor("POST", "conversations.messages"), {
    endpoint: "message.send", windowSeconds: 60, ipLimit: 120, userLimit: 30,
  });
  // "Other conversation/session/notification writes" are 60/120 a minute. They
  // used to inherit that by falling through to a default; now it is written down.
  for (const [method, routeId] of [
    ["DELETE", "me.session"],
    ["DELETE", "conversations.item"],
    ["POST", "conversations"],
    ["PATCH", "conversations.participants"],
    ["PUT", "conversations.read"],
    ["PUT", "me.notifications.read"],
    ["POST", "me.notifications.read-all"],
  ] as const) {
    const policy = policyFor(method, routeId);
    assert.deepEqual(
      { windowSeconds: policy.windowSeconds, ipLimit: policy.ipLimit, userLimit: policy.userLimit },
      { windowSeconds: 60, ipLimit: 120, userLimit: 60 },
      `${method} ${routeId}`,
    );
  }
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
  await service.checkWrite({ policy: policyFor("POST", "articles"), ip: "192.0.2.10", actorId: "writer-123" });
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
  await service.checkWrite({ policy: policyFor("POST", "articles.comments"), ip: "192.0.2.10", actorId: null });
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
    service.checkWrite({ policy: policyFor("POST", "articles"), ip: "192.0.2.10", actorId: "writer-123" }),
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
  await service.checkWrite({ policy: policyFor("POST", "articles"), ip: "unknown", actorId: null });
  assert.equal(calls, 0);
});
