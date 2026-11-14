import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRequest } from "../src/auth.ts";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { handleArticleViewRequest } from "../src/views.ts";
import { InMemoryRefreshCoordinator, refreshCoordinatorKey } from "../src/refresh-coordinator.ts";
import { API_BASE, ROTATED, TOKENS, json, request, setCookies, stubFetch, tokenEnvelope, type StubCall } from "./helpers.ts";

const cookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${TOKENS.refreshToken}`;
const refreshCookie = `nw_refresh=${TOKENS.refreshToken}`;
const expired = () => json({ error: { code: "TOKEN_EXPIRED", message: "Access expired." } }, 401);
const bearer = (call: StubCall) => new Headers(call.init?.headers).get("authorization");
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  return { waiting, release, enter, entered };
}

// These are cross-entry protocol regressions, not another implementation of the
// coordinator. Every route runs its real body/origin/cookie/error policy.
test("one rotation key spans the access-cookie boundary and canonical upstream aliases", async () => {
  const withAccess = await refreshCoordinatorKey(API_BASE, TOKENS.refreshToken, TOKENS.accessToken);
  const withoutAccess = await refreshCoordinatorKey(API_BASE, TOKENS.refreshToken, undefined);
  assert.equal(withAccess, withoutAccess);
  assert.equal(withAccess, await refreshCoordinatorKey(API_BASE + "/", TOKENS.refreshToken, "unrelated-access"));
  assert.match(withAccess, /^[0-9a-f]{64}$/);
  assert.equal(withAccess.includes(TOKENS.refreshToken), false);
  assert.equal(withAccess.includes(TOKENS.accessToken), false);
  assert.notEqual(withAccess, await refreshCoordinatorKey(API_BASE, ROTATED.refreshToken, undefined));
  assert.notEqual(withAccess, await refreshCoordinatorKey("https://other.example.test", TOKENS.refreshToken, undefined));
  assert.notEqual(withAccess, await refreshCoordinatorKey(API_BASE + "/other-api", TOKENS.refreshToken, undefined));
});

test("two automatic 401s with old-access and absent-access cookies share one upstream rotation", async () => {
  const hold = gate();
  const stub = stubFetch({
    "api/v1/auth/refresh": async () => { hold.enter(); await hold.waiting; return tokenEnvelope(ROTATED); },
    "api/v1/me/articles": (call) => bearer(call) === `Bearer ${ROTATED.accessToken}` ? json({ data: ["private-work"] }) : expired(),
  });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const first = forwardAuthoringRequest(request("/api/authoring/articles", { headers: { cookie } }), "api/v1/me/articles", "GET", config);
  const second = forwardAuthoringRequest(request("/api/authoring/articles", { headers: { cookie: refreshCookie } }), "api/v1/me/articles", "GET", config);
  await hold.entered;
  hold.release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
  assert.equal(stub.calls.filter((call) => bearer(call) === `Bearer ${ROTATED.accessToken}`).length, 2);
  for (const response of responses) {
    assert.deepEqual(await response.json(), { data: ["private-work"] });
    assert.equal(setCookies(response).length, 3);
    assert.ok(setCookies(response).some((value) => value.startsWith(`nw_refresh=${ROTATED.refreshToken};`)));
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("explicit and automatic refresh join the same flight regardless of which entry wins", async () => {
  for (const firstEntry of ["explicit", "automatic"]) {
    const hold = gate();
    const stub = stubFetch({
      "api/v1/auth/refresh": async () => { hold.enter(); await hold.waiting; return tokenEnvelope(ROTATED); },
      "api/v1/me": (call) => bearer(call) === `Bearer ${ROTATED.accessToken}` ? json({ data: { id: "reader" } }) : expired(),
    });
    const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
    const explicit = () => handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie }, body: '{"refreshToken":"ignored-browser-body"}' }), "refresh", config);
    const automatic = () => forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
    const winner = firstEntry === "explicit" ? explicit() : automatic();
    await hold.entered;
    const sibling = firstEntry === "explicit" ? automatic() : explicit();
    hold.release();
    const responses = await Promise.all([winner, sibling]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const rotations = stub.calls.filter(({ url }) => url.endsWith("/auth/refresh"));
    assert.equal(rotations.length, 1, firstEntry);
    assert.deepEqual(JSON.parse(String(rotations[0]!.init?.body)), { refreshToken: TOKENS.refreshToken });
    for (const response of responses) {
      assert.ok(setCookies(response).some((value) => value.startsWith(`nw_access=${ROTATED.accessToken};`)));
      const text = await response.text();
      assert.equal(text.includes(ROTATED.accessToken), false);
      assert.equal(text.includes(ROTATED.refreshToken), false);
    }
  }
});

test("parallel explicit refreshes do not consume a one-time token once per browser request", async () => {
  const hold = gate();
  const stub = stubFetch({ "api/v1/auth/refresh": async () => { hold.enter(); await hold.waiting; return tokenEnvelope(ROTATED); } });
  const attempts = [cookie, refreshCookie, `${refreshCookie}; nw_access=other-old-access`].map((value) => handleAuthRequest(
    request("/api/auth/refresh", { headers: { cookie: value, authorization: "Bearer browser-controlled" } }), "refresh", { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  ));
  await hold.entered;
  hold.release();
  const responses = await Promise.all(attempts);
  assert.equal(stub.calls.length, 1);
  assert.equal(new Headers(stub.calls[0]!.init?.headers).has("authorization"), false);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { tokenType: "Bearer", accessExpiresAt: ROTATED.accessExpiresAt } });
    assert.equal(setCookies(response).length, 3);
    assert.ok(setCookies(response).filter((value) => /^nw_(access|refresh)=/.test(value)).every((value) => value.includes("HttpOnly")));
  }
});

test("a viewer guard's refresh 429 is relayed instead of silently becoming anonymous attribution", async () => {
  const stub = stubFetch({
    "api/v1/me": expired,
    "api/v1/auth/refresh": () => json({ error: { code: "RATE_LIMITED", message: "Wait before refreshing." }, private: "not-public" }, 429, { "retry-after": "00027", "set-cookie": "untrusted=1", "x-private": "not-public" }),
  });
  const response = await handleArticleViewRequest(request("/api/authoring/articles/work/views", { headers: { cookie: refreshCookie } }), { slug: "work", locale: "en" }, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "27");
  assert.deepEqual(await response.json(), { error: { code: "RATE_LIMITED", message: "Wait before refreshing." } });
  assert.equal(setCookies(response).length, 0);
  assert.equal(response.headers.get("x-private"), null);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(stub.calls.map(({ url }) => new URL(url).pathname), ["/api/v1/me", "/api/v1/auth/refresh"]);
  assert.ok(stub.calls.every(({ url }) => !url.includes("/views")));
});

test("a mixed refresh burst shares its 429 and keeps every caller's cookies untouched", async () => {
  const hold = gate();
  const stub = stubFetch({
    "api/v1/me": expired,
    "api/v1/auth/refresh": async () => { hold.enter(); await hold.waiting; return json({ error: { code: "RATE_LIMITED", message: "Try later." } }, 429, { "retry-after": "45" }); },
  });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const automatic = forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
  await hold.entered;
  const explicit = handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  hold.release();
  const responses = await Promise.all([automatic, explicit]);
  assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
  for (const response of responses) {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "45");
    assert.equal(setCookies(response).length, 0);
    assert.deepEqual(await response.json(), { error: { code: "RATE_LIMITED", message: "Try later." } });
  }
});

test("malformed Retry-After never escapes the automatic refresh boundary", async () => {
  for (const header of ["0", "-1", "not-a-date", "9".repeat(200), "", "9999999999"]) {
    const stub = stubFetch({ "api/v1/me": expired, "api/v1/auth/refresh": () => json({ error: { code: "RATE_LIMITED", message: "Too soon." } }, 429, { "retry-after": header }) });
    const response = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), header === "9999999999" ? "86400" : null);
    assert.equal(setCookies(response).length, 0);
    assert.equal(stub.calls.length, 2);
  }
});

test("a shared refresh timeout preserves automatic 401 semantics and explicit 504 semantics", async () => {
  const hold = gate();
  const stub = stubFetch({ "api/v1/me": expired, "api/v1/auth/refresh": () => { hold.enter(); return new Promise<Response>(() => {}); } });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: 50 };
  const automatic = forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
  await hold.entered;
  const explicit = handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  const [original, direct] = await Promise.all([automatic, explicit]);
  assert.equal(original.status, 401);
  assert.equal(direct.status, 504);
  assert.equal((await direct.json()).error.code, "UPSTREAM_TIMEOUT");
  assert.equal((await original.json()).error.code, "TOKEN_EXPIRED");
  assert.equal(setCookies(original).length, 0);
  assert.equal(setCookies(direct).length, 0);
  assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
});

test("a throttled rotation is transient, not a five-second credential rejection", async () => {
  let now = 1000, rotations = 0;
  const coordinator = new InMemoryRefreshCoordinator({ now: () => now });
  const stub = stubFetch({
    "api/v1/me": (call) => bearer(call) === `Bearer ${ROTATED.accessToken}` ? json({ data: { id: "reader" } }) : expired(),
    "api/v1/auth/refresh": () => ++rotations === 1 ? json({ error: { code: "RATE_LIMITED", message: "Back off." } }, 429, { "retry-after": "1" }) : tokenEnvelope(ROTATED),
  });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, refreshCoordinator: coordinator };
  const first = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  assert.equal(first.status, 429);
  now += 100;
  const sibling = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
  assert.equal(sibling.status, 429);
  assert.equal(rotations, 1);
  now += 1000;
  const retried = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie: refreshCookie } }), "api/v1/me", "GET", config);
  assert.equal(retried.status, 200);
  assert.equal(rotations, 2);
  assert.ok(setCookies(retried).some((value) => value.startsWith(`nw_refresh=${ROTATED.refreshToken};`)));
});

test("both entries honor the explicitly injected coordinator without handing it raw credentials", async () => {
  const keys: string[] = [];
  const ledger = new InMemoryRefreshCoordinator();
  const stub = stubFetch({ "api/v1/me": (call) => bearer(call) === `Bearer ${ROTATED.accessToken}` ? json({ data: { id: "reader" } }) : expired(), "api/v1/auth/refresh": () => tokenEnvelope(ROTATED) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, refreshCoordinator: { resolve: (key: string, rotate: Parameters<typeof ledger.resolve>[1]) => { keys.push(key); return ledger.resolve(key, rotate); } } };
  const explicit = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  const automatic = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
  assert.equal(explicit.status, 200);
  assert.equal(automatic.status, 200);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0]!, /^[a-f0-9]{64}$/);
  assert.equal(keys[0]!.includes(TOKENS.refreshToken), false);
  assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
});

test("a refreshed actor conflict never replays a protected write even when an explicit caller shares the tokens", async () => {
  const stub = stubFetch({ "api/v1/me": (call) => bearer(call) === `Bearer ${ROTATED.accessToken}` ? json({ data: { id: "replacement-actor" } }) : expired(), "api/v1/auth/refresh": () => tokenEnvelope(ROTATED) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const direct = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  const guarded = await forwardAuthoringRequest(request("/api/authoring/notifications/read-all", { headers: { cookie, "idempotency-key": "original-intent" } }), "api/v1/notifications/read-all", "POST", config, undefined, undefined, "original-actor");
  assert.equal(direct.status, 200);
  assert.equal(guarded.status, 409);
  assert.equal((await guarded.json()).error.code, "ACCOUNT_CHANGED");
  assert.ok(stub.calls.every(({ url }) => !url.endsWith("/notifications/read-all")));
  assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
  assert.ok(setCookies(guarded).some((value) => value.startsWith(`nw_access=${ROTATED.accessToken};`)));
});

test("one mutation retry retains its exact bytes and idempotency key after a shared explicit rotation", async () => {
  const body = '{ "title": "an unchanged intent", "contentBlocks": [] }';
  const stub = stubFetch({ "api/v1/auth/refresh": () => tokenEnvelope(ROTATED), "api/v1/articles": (call) => bearer(call) === `Bearer ${ROTATED.accessToken}` ? json({ data: { id: "persisted-once" } }, 201) : expired() });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  assert.equal((await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config)).status, 200);
  const response = await forwardAuthoringRequest(request("/api/authoring/articles", { headers: { cookie, "idempotency-key": "one-editor-intent" } }), "api/v1/articles", "POST", config, body);
  assert.equal(response.status, 201);
  const writes = stub.calls.filter(({ url }) => url.endsWith("/articles"));
  assert.equal(writes.length, 2);
  assert.ok(writes.every(({ init }) => init?.body === body));
  assert.ok(writes.every(({ init }) => new Headers(init?.headers).get("idempotency-key") === "one-editor-intent"));
  assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
  assert.deepEqual(await response.json(), { data: { id: "persisted-once" } });
});

test("an unavailable external coordinator cannot throw past either HTTP entry or bypass its lock", async () => {
  const stub = stubFetch({ "api/v1/me": expired });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, refreshCoordinator: { async resolve(): Promise<never> { throw new Error("fixture coordinator transport unavailable"); } } };
  const direct = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  const automatic = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
  assert.equal(direct.status, 502);
  assert.equal((await direct.json()).error.code, "SERVICE_UNAVAILABLE");
  assert.equal(automatic.status, 401);
  assert.equal((await automatic.json()).error.code, "TOKEN_EXPIRED");
  assert.equal(setCookies(direct).length, 0);
  assert.equal(setCookies(automatic).length, 0);
  assert.equal(stub.calls.length, 1, "never fall back to an uncoordinated rotation");
  assert.ok(stub.calls.every(({ url }) => !url.endsWith("/auth/refresh")));
});

test("invalid upstream key configuration is a private explicit error, never an uncaught credential-bearing failure", async () => {
  const stub = stubFetch({});
  const response = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", { apiBaseUrl: "not-an-absolute-api-origin", fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: "SERVICE_UNAVAILABLE", message: "The API service could not be reached." } });
  assert.equal(setCookies(response).length, 0);
  assert.equal(stub.calls.length, 0);
});

test("shared wire failures preserve each route's refusal policy without leaking upstream bodies or headers", async () => {
  for (const status of [400, 401, 403, 404, 422, 500, 502, 503]) {
    const stub = stubFetch({ "api/v1/me": expired, "api/v1/auth/refresh": () => json({ error: { code: "FIXTURE_REFUSAL", message: "Safe four-hundred detail." }, internal: "fixture-internal-diagnostic" }, status, { "set-cookie": "upstream-trap=1", "x-diagnostic": "private", location: "https://untrusted.example.test" }) });
    const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
    const direct = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
    const automatic = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
    assert.equal(direct.status, status);
    assert.equal(automatic.status, 401, "non-throttle refresh failures retain the original resource refusal");
    const directError = (await direct.json()).error;
    assert.equal(directError.code, status >= 500 ? "SERVICE_UNAVAILABLE" : "FIXTURE_REFUSAL");
    assert.equal(directError.message, status >= 500 ? "The authentication service is temporarily unavailable." : "Safe four-hundred detail.");
    assert.equal((await automatic.json()).error.code, "TOKEN_EXPIRED");
    assert.equal(setCookies(direct).length, 0, "explicit refresh keeps its existing rejection policy");
    assert.equal(setCookies(automatic).length, status === 400 || status === 401 ? 3 : 0);
    assert.ok(setCookies(automatic).every((value) => value.includes("Max-Age=0")));
    for (const response of [direct, automatic]) {
      assert.equal(response.headers.get("x-diagnostic"), null);
      assert.equal(response.headers.get("location"), null);
      assert.ok(setCookies(response).every((value) => !value.startsWith("upstream-trap=")));
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    assert.equal(stub.calls.filter(({ url }) => url.endsWith("/auth/refresh")).length, 1);
  }
});

test("an invalid successful refresh envelope cannot be cached as a session or clear cookies", async () => {
  const stub = stubFetch({ "api/v1/me": expired, "api/v1/auth/refresh": () => json({ data: { ...ROTATED, refreshToken: null } }) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const direct = await handleAuthRequest(request("/api/auth/refresh", { headers: { cookie: refreshCookie } }), "refresh", config);
  const automatic = await forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config);
  assert.equal(direct.status, 502);
  assert.equal((await direct.json()).error.code, "INVALID_AUTH_RESPONSE");
  assert.equal(automatic.status, 401);
  assert.equal((await automatic.json()).error.code, "TOKEN_EXPIRED");
  assert.equal(setCookies(direct).length, 0);
  assert.equal(setCookies(automatic).length, 0);
  assert.equal(stub.calls.length, 2, "a malformed result is shared but cannot authorize a resource retry");
});
