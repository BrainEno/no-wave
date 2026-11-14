import assert from "node:assert/strict";
import test from "node:test";
import type { ApiProxyConfig } from "../src/api.ts";
import { handleNotificationsRequest, handleNotificationsUnreadCountRequest, handleNotificationsReadAllRequest, handleNotificationReadRequest } from "../src/notifications.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, ROTATED, assertNoStore, json, stubFetch, tokenEnvelope } from "./helpers.ts";

const ACTOR = "notification-reader-original";
const OTHER = "notification-reader-replacement";
const ID = "73800000-0000-4000-8000-000000000001";
const HEADER = "x-expected-notification-actor";
const cursor = Buffer.from(`2026-11-01T00:00:00.000Z|${ID}`).toString("base64url");
const routes = [
  { name: "history", method: "GET", path: `/api/v1/me/notifications?limit=17&cursor=${cursor}`, data: [] },
  { name: "badge", method: "GET", path: "/api/v1/me/notifications/unread-count", data: 52 },
  { name: "mark-all", method: "POST", path: "/api/v1/me/notifications/read-all", data: 51 },
  { name: "mark-one", method: "PUT", path: `/api/v1/me/notifications/${ID}/read`, data: { id: ID, readAt: "2026-11-01T00:00:00.000Z" } },
] as const;
type Route = typeof routes[number];
function request(route: Route, actor: string | null = ACTOR, refresh = false, overrides: Record<string, string> = {}) {
  const headers = new Headers({ origin: "https://no-wave.test", host: "no-wave.test",
    cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}${refresh ? `; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}` : ""}`, ...overrides });
  if (actor !== null) headers.set(HEADER, actor);
  return new Request(`https://no-wave.test/api/authoring/notifications?limit=17&cursor=${cursor}`, { method: route.method, headers });
}
function handle(route: Route, req: Request, config: ApiProxyConfig) {
  if (route.name === "history") return handleNotificationsRequest(req, config);
  if (route.name === "badge") return handleNotificationsUnreadCountRequest(req, config);
  if (route.name === "mark-all") return handleNotificationsReadAllRequest(req, config);
  return handleNotificationReadRequest(req, { id: ID }, config);
}

for (const route of routes) {
  test(`${route.name}: an old notification surface cannot read or change the replacement recipient`, async () => {
    const stub = stubFetch({ "api/v1/me/notifications": () => json({ data: route.data }), "api/v1/me": () => json({ data: { id: OTHER } }) });
    const response = await handle(route, request(route), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
    assertNoStore(response);
    assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), ["/api/v1/me"]);
  });

  test(`${route.name}: identity and the precise notification operation use one verified credential`, async () => {
    const stub = stubFetch({ "api/v1/me/notifications": () => json({ data: route.data }), "api/v1/me": () => json({ data: { id: ACTOR } }) });
    const response = await handle(route, request(route), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: route.data });
    assertNoStore(response);
    assert.deepEqual(stub.calls.map((call) => call.url), [`${API_BASE}/api/v1/me`, `${API_BASE}${route.path}`]);
    assert.deepEqual(stub.calls.map((call) => call.init?.method), ["GET", route.method]);
    for (const call of stub.calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
      assert.equal(headers.get(HEADER), null);
      assert.equal(headers.get("cookie"), null);
      assert.equal(call.init?.body, undefined);
      assert.equal(call.init?.cache, "no-store");
    }
  });

  test(`${route.name}: malformed actor restrictions cannot silently turn into an unbound notification request`, async () => {
    for (const actor of ["", "a,b", "%", "%FE", "%00reader", "%20reader", "reader%20", "reader name", "a%0Db", "x".repeat(301)]) {
      const stub = stubFetch({ "api/v1/": () => json({ data: route.data }) });
      const response = await handle(route, request(route, actor), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 400, JSON.stringify(actor));
      assert.equal((await response.json()).error.code, "BAD_USER_INPUT");
      assertNoStore(response);
      assert.equal(stub.calls.length, 0);
    }
  });

  test(`${route.name}: legacy callers remain compatible without the optional restriction`, async () => {
    const stub = stubFetch({ "api/v1/me/notifications": () => json({ data: route.data }) });
    const response = await handle(route, request(route, null), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: route.data });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${API_BASE}${route.path}`);
  });

  test(`${route.name}: Unicode and literal percent recipient IDs are decoded once without a UUID assumption`, async () => {
    for (const actor of ["通知讀者", "reader name", "reader,name", "reader%2Fname", "讀".repeat(300)]) {
      const stub = stubFetch({ "api/v1/me/notifications": () => json({ data: route.data }), "api/v1/me": () => json({ data: { id: actor } }) });
      const response = await handle(route, request(route, encodeURIComponent(actor)), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 200);
      assert.equal(stub.calls.length, 2);
    }
    const stub = stubFetch({ "api/v1/me": () => json({ data: { id: "reader/name" } }), "api/v1/me/notifications": () => json({ data: route.data }) });
    const mismatch = await handle(route, request(route, encodeURIComponent("reader%2Fname")), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(mismatch.status, 409, "a second decode would wrongly accept a different recipient");
    assert.equal(stub.calls.length, 1);
  });

  test(`${route.name}: a rejected identity cannot be presented as an empty inbox or an accepted read`, async () => {
    for (const status of [401, 403, 429, 503]) {
      const stub = stubFetch({ "api/v1/me/notifications": () => json({ data: route.data }), "api/v1/me": () => json({ error: { code: "IDENTITY_UNAVAILABLE" } }, status) });
      const response = await handle(route, request(route), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, status);
      assert.equal(stub.calls.length, 1);
      assertNoStore(response);
    }
  });

  test(`${route.name}: refreshing a stale session rechecks the recipient before the notification operation`, async () => {
    for (const replacement of [ACTOR, OTHER]) {
      let identified = 0;
      const stub = stubFetch({
        "api/v1/me/notifications": () => json({ data: route.data }),
        "api/v1/me": () => ++identified === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: replacement } }),
        "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
      });
      const response = await handle(route, request(route, ACTOR, true), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, replacement === ACTOR ? 200 : 409);
      assertNoStore(response);
      assert.equal(identified, 2);
      assert.equal(stub.calls.length, replacement === ACTOR ? 4 : 3);
      assert.equal(new Headers(stub.calls[2].init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
      if (replacement === ACTOR) {
        assert.equal(stub.calls[3].url, `${API_BASE}${route.path}`);
        assert.equal(new Headers(stub.calls[3].init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
      }
      assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${ACCESS_TOKEN_COOKIE}=`)));
    }
  });
}

test("a resource 401 cannot replay a notification mark-all after rotation changes the actor", async () => {
  const route = routes[2];
  let identities = 0;
  let mutations = 0;
  const stub = stubFetch({
    "api/v1/me/notifications": () => { mutations++; return json({ error: { code: "UNAUTHENTICATED" } }, 401); },
    "api/v1/me": () => json({ data: { id: ++identities === 1 ? ACTOR : OTHER } }),
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
  });
  const response = await handle(route, request(route, ACTOR, true), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 409);
  assert.equal(mutations, 1);
  assert.equal(identities, 2);
  assert.deepEqual(stub.calls.map((call) => call.init?.method), ["GET", "POST", "POST", "GET"]);
});

test("notification write method and same-origin checks precede actor or resource inspection", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: true }) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const wrong = new Request("https://no-wave.test/api/notifications/read-all", { method: "DELETE", headers: { [HEADER]: "%" } });
  assert.equal((await handleNotificationsReadAllRequest(wrong, config)).status, 405);
  const cross = request(routes[2], "%", false, { origin: "https://other.test" });
  assert.equal((await handleNotificationsReadAllRequest(cross, config)).status, 403);
  const invalid = request(routes[3], "%", false, { origin: "https://other.test" });
  assert.equal((await handleNotificationReadRequest(invalid, { id: "not-an-id" }, config)).status, 403);
  assert.equal(stub.calls.length, 0);
});

test("an expected recipient header without credentials never establishes an authenticated notification identity", async () => {
  const stub = stubFetch({ "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED" } }, 401), "api/v1/me/notifications": () => json({ data: 3 }) });
  const req = new Request("https://no-wave.test/api/notifications/read-all", { method: "POST", headers: { origin: "https://no-wave.test", host: "no-wave.test", [HEADER]: ACTOR } });
  const response = await handleNotificationsReadAllRequest(req, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 401);
  assert.equal(stub.calls.length, 1);
  assert.equal(new Headers(stub.calls[0].init?.headers).get("authorization"), null);
});

test("unusable identity envelopes cannot fall back to any of the four notification operations", async () => {
  for (const route of routes) {
    for (const data of [null, [], {}, { id: null }, { id: "" }]) {
      const stub = stubFetch({ "api/v1/me/notifications": () => json({ data: route.data }), "api/v1/me": () => json({ data }) });
      const response = await handle(route, request(route), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 502, route.name);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].url, `${API_BASE}/api/v1/me`);
      assertNoStore(response);
    }
  }
});
