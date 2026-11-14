import assert from "node:assert/strict";
import test from "node:test";
import type { ApiProxyConfig } from "../src/api.ts";
import { handleInboxRequest, handleConversationRequest, handleConversationMessagesRequest } from "../src/messages.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, ROTATED, assertNoStore, json, stubFetch, tokenEnvelope } from "./helpers.ts";

const ACTOR = "54e4e0db-3f69-458b-8eee-e58ad4755f31";
const OTHER = "b3e3bac3-341f-4d64-a247-38069ad34123";
const CONVERSATION = "76e59a17-10b2-4272-9089-e2a475d7aa66";
const HEADER = "x-expected-messaging-actor";
const surfaces = ["inbox", "header", "history"] as const;
type Surface = typeof surfaces[number];
function request(actor: string | null = ACTOR, refresh = false, method = "GET"): Request {
  const headers = new Headers({ cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}${refresh ? `; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}` : ""}` });
  if (actor !== null) headers.set(HEADER, actor);
  return new Request("https://no-wave.test/api/authoring/inbox", { method, headers });
}
function handle(surface: Surface, req: Request, config: ApiProxyConfig): Promise<Response> {
  if (surface === "inbox") return handleInboxRequest(req, { limit: "37" }, config);
  if (surface === "header") return handleConversationRequest(req, { conversationId: CONVERSATION }, config);
  return handleConversationMessagesRequest(req, { conversationId: CONVERSATION, limit: "19", before: "opaque /?&cursor" }, config);
}
function path(surface: Surface): string {
  if (surface === "inbox") return "/api/v1/conversations?limit=37";
  if (surface === "header") return `/api/v1/conversations/${CONVERSATION}`;
  return `/api/v1/conversations/${CONVERSATION}/messages?limit=19&before=opaque%20%2F%3F%26cursor`;
}

for (const surface of surfaces) {
  test(`${surface}: another verified account is rejected before any private resource read`, async () => {
    const stub = stubFetch({ "api/v1/me": () => json({ data: { id: OTHER } }), "api/v1/conversations": () => json({ data: [] }) });
    const response = await handle(surface, request(), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
    assertNoStore(response);
    assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), ["/api/v1/me"]);
  });

  test(`${surface}: the verified token, not a claimed ID or a fresh browser preflight, owns the following read`, async () => {
    const stub = stubFetch({ "api/v1/me": () => json({ data: { id: ACTOR } }), "api/v1/conversations": () => json({ data: [] }) });
    const response = await handle(surface, request(), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [] });
    assertNoStore(response);
    assert.deepEqual(stub.calls.map((call) => call.url), [`${API_BASE}/api/v1/me`, `${API_BASE}${path(surface)}`]);
    for (const call of stub.calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
      assert.equal(headers.get(HEADER), null, "the restriction never becomes an API identity header");
      assert.equal(headers.get("cookie"), null);
      assert.equal(headers.get("idempotency-key"), null);
      assert.equal(call.init?.method, "GET");
      assert.equal(call.init?.body, undefined);
      assert.equal(call.init?.cache, "no-store");
    }
  });

  test(`${surface}: legacy callers without an expected account retain exactly one authorized read`, async () => {
    for (const status of [200, 401, 403, 404, 429, 503]) {
      const payload = status === 200 ? { data: [] } : { error: { code: `PRIVATE_${status}` } };
      const stub = stubFetch({ "api/v1/conversations": () => json(payload, status) });
      const response = await handle(surface, request(null), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), payload);
      assertNoStore(response);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].url, `${API_BASE}${path(surface)}`);
    }
  });

  test(`${surface}: malformed, coalesced and invalid UTF-8 preconditions fail without an upstream call`, async () => {
    for (const actor of ["", "%", "%GG", "%C3%28", `${ACTOR},${OTHER}`, `${ACTOR}, ${ACTOR}`, "with space", "%20padded", "trailing%20", "a%00b", "a%0Ab", "x".repeat(301)]) {
      const stub = stubFetch({ "api/v1/": () => json({ data: [] }) });
      const response = await handle(surface, request(actor), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 400, actor);
      assertNoStore(response);
      assert.equal(stub.calls.length, 0);
    }
  });

  test(`${surface}: encoded Unicode, punctuation and literal percent IDs are compared exactly once`, async () => {
    for (const actor of ["讀者甲", "reader name", "reader,name", "reader%2Fname"]) {
      const stub = stubFetch({ "api/v1/me": () => json({ data: { id: actor } }), "api/v1/conversations": () => json({ data: [] }) });
      const response = await handle(surface, request(encodeURIComponent(actor)), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 200);
      assertNoStore(response);
      assert.equal(stub.calls.length, 2);
      assert.equal(new Headers(stub.calls[1].init?.headers).get(HEADER), null);
    }
  });

  test(`${surface}: malformed account envelopes never fall back to an unbound read`, async () => {
    for (const payload of [null, [], {}, { data: {} }, { data: { id: null } }, { data: { id: "" } }]) {
      const stub = stubFetch({ "api/v1/me": () => json(payload), "api/v1/conversations": () => json({ data: [] }) });
      const response = await handle(surface, request(), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 502, JSON.stringify(payload));
      assertNoStore(response);
      assert.equal(stub.calls.length, 1);
    }
  });

  test(`${surface}: a failed identity read preserves the status and cannot expose an empty private list`, async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const stub = stubFetch({ "api/v1/me": () => json({ error: { code: `IDENTITY_${status}` } }, status), "api/v1/conversations": () => json({ data: [] }) });
      const response = await handle(surface, request(), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, status);
      assertNoStore(response);
      assert.equal(stub.calls.length, 1);
    }
  });

  test(`${surface}: same-account refresh verifies the new token before reading the exact path`, async () => {
    let identities = 0;
    const stub = stubFetch({
      "api/v1/me": () => ++identities === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: ACTOR } }),
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED), "api/v1/conversations": () => json({ data: [] }),
    });
    const response = await handle(surface, request(ACTOR, true), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assertNoStore(response);
    assert.equal(identities, 2);
    assert.deepEqual(stub.calls.map((call) => call.url), [`${API_BASE}/api/v1/me`, `${API_BASE}/api/v1/auth/refresh`, `${API_BASE}/api/v1/me`, `${API_BASE}${path(surface)}`]);
    assert.equal(new Headers(stub.calls[2].init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
    assert.equal(new Headers(stub.calls[3].init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
    assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${ACCESS_TOKEN_COOKIE}=`)));
  });

  test(`${surface}: account replacement during refresh cannot receive a replayed private read`, async () => {
    let identities = 0;
    const stub = stubFetch({
      "api/v1/me": () => ++identities === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: OTHER } }),
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED), "api/v1/conversations": () => json({ data: [] }),
    });
    const response = await handle(surface, request(ACTOR, true), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
    assertNoStore(response);
    assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), ["/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me"]);
  });

  test(`${surface}: resource 401 rechecks identity on retry rather than trusting a previous preflight`, async () => {
    let identities = 0;
    let reads = 0;
    const stub = stubFetch({
      "api/v1/me": () => json({ data: { id: ++identities === 1 ? ACTOR : OTHER } }),
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
      "api/v1/conversations": () => { reads++; return json({ error: { code: "UNAUTHENTICATED" } }, 401); },
    });
    const response = await handle(surface, request(ACTOR, true), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assertNoStore(response);
    assert.equal(reads, 1);
    assert.equal(identities, 2);
    assert.equal(stub.calls[1].url, `${API_BASE}${path(surface)}`);
  });

  test(`${surface}: wrong methods are rejected before inspecting an expected account`, async () => {
    const stub = stubFetch({ "api/v1/": () => json({ data: [] }) });
    const response = await handle(surface, request("", false, "POST"), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 405);
    assertNoStore(response);
    assert.equal(stub.calls.length, 0);
  });
}
