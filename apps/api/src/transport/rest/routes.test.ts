import assert from "node:assert/strict";
import test from "node:test";
import { REST_ROUTES, resolveRestRoute } from "./routes.ts";

/**
 * Classification contract for the REST surface.
 *
 * These assertions replace the hand-maintained regex prelude and the 26-branch
 * `405` chain that preceded the route table (issue #58): if a path starts or stops
 * being recognised, or its allowed methods change, this test fails before the
 * transport can start answering differently.
 */

test("every documented collection route matches with the expected methods", () => {
  const cases: Array<[string, string, string]> = [
    ["/api/v1/health", "GET", "health"],
    ["/api/v1/me", "GET", "me"],
    ["/api/v1/me/profile", "GET", "me.profile"],
    ["/api/v1/me/profile", "PUT", "me.profile"],
    ["/api/v1/me/session", "DELETE", "me.session"],
    ["/api/v1/me/liked-articles", "GET", "me.liked-articles"],
    ["/api/v1/me/articles", "GET", "me.articles"],
    ["/api/v1/me/media", "POST", "me.media"],
    ["/api/v1/me/notifications", "GET", "me.notifications"],
    ["/api/v1/me/notifications/unread-count", "GET", "me.notifications.unread-count"],
    ["/api/v1/me/notifications/read-all", "POST", "me.notifications.read-all"],
    ["/api/v1/users", "GET", "users"],
    ["/api/v1/articles", "GET", "articles"],
    ["/api/v1/articles", "POST", "articles"],
    ["/api/v1/categories", "GET", "categories"],
    ["/api/v1/tags", "GET", "tags"],
    ["/api/v1/tags", "POST", "tags"],
    ["/api/v1/taxonomies", "POST", "taxonomies"],
    ["/api/v1/conversations", "GET", "conversations"],
    ["/api/v1/conversations", "POST", "conversations"],
  ];
  for (const [pathname, method, id] of cases) {
    const resolution = resolveRestRoute(pathname, method);
    assert.equal(resolution.kind, "matched", `${method} ${pathname} should match`);
    assert.equal(resolution.kind === "matched" ? resolution.id : null, id);
  }
});

test("parameterised routes capture their parameters", () => {
  const expectations: Array<[string, string, Record<string, string>]> = [
    ["/api/v1/auth/login", "POST", { action: "login" }],
    ["/api/v1/articles/portable-web-foundation", "GET", { slug: "portable-web-foundation" }],
    ["/api/v1/articles/portable-web-foundation", "PUT", { slug: "portable-web-foundation" }],
    ["/api/v1/articles/portable-web-foundation/like", "GET", { slug: "portable-web-foundation" }],
    ["/api/v1/articles/portable-web-foundation/comments", "POST", { slug: "portable-web-foundation" }],
    ["/api/v1/articles/portable-web-foundation/related", "GET", { slug: "portable-web-foundation" }],
    ["/api/v1/comments/11111111-1111-4111-8111-111111111111", "DELETE", { id: "11111111-1111-4111-8111-111111111111" }],
    ["/api/v1/users/writer/follow", "POST", { username: "writer" }],
    ["/api/v1/users/writer/followers", "GET", { username: "writer", relation: "followers" }],
    ["/api/v1/users/writer/following", "GET", { username: "writer", relation: "following" }],
    ["/api/v1/conversations/c1/messages", "GET", { id: "c1" }],
    ["/api/v1/conversations/c1/participants", "PATCH", { id: "c1" }],
    ["/api/v1/conversations/c1/read", "PUT", { id: "c1" }],
    ["/api/v1/me/notifications/n1/read", "PUT", { id: "n1" }],
    ["/api/v1/authors/writer", "GET", { username: "writer" }],
    ["/api/v1/authors/writer/articles", "GET", { username: "writer" }],
    ["/api/v1/categories/essay/articles", "GET", { slug: "essay" }],
    ["/api/v1/tags/portability/articles", "GET", { slug: "portability" }],
    ["/api/v1/media/abc123", "GET", { id: "abc123" }],
    ["/api/v1/taxonomies/t1", "DELETE", { id: "t1" }],
  ];
  for (const [pathname, method, params] of expectations) {
    const resolution = resolveRestRoute(pathname, method);
    assert.equal(resolution.kind, "matched", `${method} ${pathname} should match`);
    if (resolution.kind === "matched") assert.deepEqual({ ...resolution.params }, params);
  }
});

test("a known path with an unsupported method reports the exact allow-list", () => {
  const expectations: Array<[string, string, string]> = [
    ["/api/v1/health", "POST", "GET"],
    ["/api/v1/auth/login", "GET", "POST"],
    ["/api/v1/me", "POST", "GET"],
    ["/api/v1/me/profile", "DELETE", "GET, PUT"],
    ["/api/v1/me/session", "GET", "DELETE"],
    ["/api/v1/articles", "PUT", "GET, POST"],
    ["/api/v1/articles/some-slug", "DELETE", "GET, PUT"],
    ["/api/v1/articles/some-slug/like", "POST", "GET, PUT"],
    ["/api/v1/articles/some-slug/comments", "PUT", "GET, POST"],
    ["/api/v1/comments/some-id", "GET", "DELETE"],
    ["/api/v1/tags", "DELETE", "GET, POST"],
    ["/api/v1/taxonomies", "GET", "POST"],
    ["/api/v1/conversations/c1/messages", "PUT", "GET, POST"],
    ["/api/v1/conversations/c1/participants", "POST", "PATCH"],
    ["/api/v1/me/notifications/read-all", "GET", "POST"],
  ];
  for (const [pathname, method, allow] of expectations) {
    const resolution = resolveRestRoute(pathname, method);
    assert.equal(resolution.kind, "method_not_allowed", `${method} ${pathname} should be rejected`);
    assert.equal(resolution.kind === "method_not_allowed" ? resolution.allow : null, allow);
  }
});

test("unknown paths fall through for reads and are rejected for writes", () => {
  // Preserves the previous catch-all: an unknown read reaches the GET dispatch
  // (and its 404), while an unknown write is rejected before any handler runs.
  assert.deepEqual(resolveRestRoute("/api/v1/nonexistent", "GET"), { kind: "unmatched" });
  assert.deepEqual(resolveRestRoute("/api/v1/articles/abc/unknown-tail", "GET"), { kind: "unmatched" });
  assert.deepEqual(resolveRestRoute("/api/v1", "GET"), { kind: "unmatched" });
  assert.deepEqual(resolveRestRoute("/api/v1/", "GET"), { kind: "unmatched" });
  assert.deepEqual(resolveRestRoute("/api/v1/nonexistent", "POST"), { kind: "method_not_allowed", allow: "GET" });
  // A non-REST path is not this transport's business at all.
  assert.deepEqual(resolveRestRoute("/health", "GET"), { kind: "unmatched" });
  assert.deepEqual(resolveRestRoute("/api/v2/articles", "GET"), { kind: "unmatched" });
});

test("the parameter enums cannot be bypassed with an unexpected value", () => {
  // `/users/:username/:relation` only accepts followers/following.
  assert.deepEqual(resolveRestRoute("/api/v1/users/writer/blocked", "GET"), { kind: "unmatched" });
  // `/auth/:action` only accepts the four identity actions.
  assert.deepEqual(resolveRestRoute("/api/v1/auth/admin", "POST"), { kind: "method_not_allowed", allow: "GET" });
});

test("route ids are unique and every route declares at least one method", () => {
  const ids = new Set<string>();
  for (const route of REST_ROUTES) {
    assert.equal(ids.has(route.id), false, `duplicate route id: ${route.id}`);
    ids.add(route.id);
    assert.ok(route.methods.length > 0, `${route.id} must accept at least one method`);
    assert.ok(route.segments.length > 0, `${route.id} must have at least one segment`);
  }
});
