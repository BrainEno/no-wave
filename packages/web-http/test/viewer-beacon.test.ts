import assert from "node:assert/strict";
import test from "node:test";
import { handleArticleViewRequest } from "../src/views.ts";
import { API_BASE, ROTATED, TOKENS, json, request, setCookies, stubFetch, tokenEnvelope } from "./helpers.ts";

const SLUG = "viewer-attribution";
const PATH = `/api/authoring/articles/${SLUG}/views?locale=en`;
const API_PATH = `api/v1/articles/${SLUG}/views?locale=en`;
const cookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${TOKENS.refreshToken}`;
const params = { slug: SLUG, locale: "en" };

test("a scoped authenticated beacon verifies the viewer before the single bodyless view mutation", async () => {
  const stub = stubFetch({
    "api/v1/me": () => json({ data: { id: "work-author" } }),
    [API_PATH]: () => json({ data: { counted: false, viewCount: 0 } }),
  });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { counted: false, viewCount: 0 } });
  assert.deepEqual(stub.calls.map(({ url, init }) => [url, init?.method]), [[`${API_BASE}/api/v1/me`, "GET"], [`${API_BASE}/${API_PATH}`, "POST"]]);
  for (const { init } of stub.calls) {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKENS.accessToken}`);
    assert.equal(init?.body, undefined);
    assert.equal(init?.cache, "no-store");
  }
  assert.equal(setCookies(response).length, 0, "a valid viewer must not rotate an otherwise valid session");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("a genuinely anonymous beacon skips identity checks and cannot adopt a browser-written bearer", async () => {
  const stub = stubFetch({ [API_PATH]: () => json({ data: { counted: true, viewCount: 1 } }) });
  const response = await handleArticleViewRequest(request(PATH, { headers: { authorization: "Bearer browser-selected" } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]!.url, `${API_BASE}/${API_PATH}`);
  assert.equal(new Headers(stub.calls[0]!.init?.headers).has("authorization"), false);
  assert.equal(stub.calls[0]!.init?.body, undefined);
  assert.equal(setCookies(response).length, 0);
  assert.deepEqual(await response.json(), { data: { counted: true, viewCount: 1 } });
});

test("a missing access cookie with a renewable session refreshes before any view is recorded", async () => {
  let checks = 0;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me": () => ++checks === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: "work-author" } }),
    [API_PATH]: () => json({ data: { counted: false, viewCount: 0 } }),
  });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie: `nw_refresh=${TOKENS.refreshToken}` } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(checks, 2);
  assert.deepEqual(stub.calls.map(({ url }) => new URL(url).pathname), ["/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me", `/api/v1/articles/${SLUG}/views`]);
  assert.equal(new Headers(stub.calls[0]!.init?.headers).has("authorization"), false);
  for (const call of stub.calls.slice(2)) assert.equal(new Headers(call.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(stub.calls.filter(({ init }) => init?.method === "POST" && init.body === undefined).length, 1);
  assert.ok(setCookies(response).some((value) => value.startsWith(`nw_access=${ROTATED.accessToken}`)));
  assert.deepEqual(await response.json(), { data: { counted: false, viewCount: 0 } });
});

test("an expired bearer cannot quietly turn an author into an anonymous 200 and self-increment", async () => {
  const stub = stubFetch({
    "api/v1/me": ({ init }) => new Headers(init?.headers).get("authorization") === `Bearer ${ROTATED.accessToken}`
      ? json({ data: { id: "work-author" } }) : json({ error: { code: "TOKEN_EXPIRED" } }, 401),
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    [API_PATH]: ({ init }) => json({ data: { counted: new Headers(init?.headers).get("authorization") !== `Bearer ${ROTATED.accessToken}`, viewCount: 0 } }),
  });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { counted: false, viewCount: 0 } });
  const writes = stub.calls.filter(({ url }) => url.includes(`/articles/${SLUG}/views`));
  assert.equal(writes.length, 1, "the pre-refresh identity failure cannot reach the telemetry mutation");
  assert.equal(new Headers(writes[0]!.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(stub.calls.filter(({ url }) => url.includes("/auth/refresh")).length, 1);
});

test("a failed identity service refuses attribution instead of consuming an anonymous reader bucket", async () => {
  const stub = stubFetch({ "api/v1/me": () => json({ error: { code: "UNAVAILABLE", message: "synthetic identity failure" } }, 503) });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 503);
  assert.equal(stub.calls.length, 1);
  assert.equal(new URL(stub.calls[0]!.url).pathname, "/api/v1/me");
  assert.equal(stub.calls[0]!.init?.method, "GET");
  assert.equal(setCookies(response).length, 0);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("a definitively rejected renewable session clears cookies but never falls back to an anonymous view", async () => {
  const stub = stubFetch({
    "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
    "api/v1/auth/refresh": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
  });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 401);
  assert.equal(stub.calls.length, 2);
  assert.ok(stub.calls.every(({ url }) => !url.includes("/views")));
  assert.equal(setCookies(response).length, 3);
  assert.ok(setCookies(response).every((value) => value.includes("Max-Age=0")));
  assert.equal(stub.calls.filter(({ url }) => url.includes("/auth/refresh")).length, 1);
});

test("an uncertain refresh outage retains cookies and does not invent anonymous success", async () => {
  const stub = stubFetch({
    "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
    "api/v1/auth/refresh": () => json({ error: { code: "UNAVAILABLE" } }, 503),
  });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 401);
  assert.equal(setCookies(response).length, 0);
  assert.equal(stub.calls.length, 2);
  assert.ok(stub.calls.every(({ url }) => !url.includes("/views")));
});

test("identity verification and view attribution both carry the trusted address callback", async () => {
  const signed: { target: string; method: string }[] = [];
  const stub = stubFetch({ "api/v1/me": () => json({ data: { id: "reader" } }), [API_PATH]: () => json({ data: { counted: true, viewCount: 2 } }) });
  const response = await handleArticleViewRequest(request(PATH, { headers: { cookie } }), params, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl,
    clientAddressHeaders: (target, method) => { signed.push({ target, method }); return { "x-nw-client-address": "192.0.2.8", "x-nw-client-address-proof": `fixture-${method}` }; },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(signed, [{ target: `${API_BASE}/api/v1/me`, method: "GET" }, { target: `${API_BASE}/${API_PATH}`, method: "POST" }]);
  assert.equal(new Headers(stub.calls[0]!.init?.headers).get("x-nw-client-address-proof"), "fixture-GET");
  assert.equal(new Headers(stub.calls[1]!.init?.headers).get("x-nw-client-address-proof"), "fixture-POST");
  assert.equal(response.headers.get("x-nw-client-address"), null);
  assert.equal(response.headers.get("x-nw-client-address-proof"), null);
});
