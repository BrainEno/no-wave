import assert from "node:assert/strict";
import test from "node:test";
import type { ApiProxyConfig } from "../src/api.ts";
import { handleConversationReadRequest, handleSendMessageRequest, handleStartConversationRequest } from "../src/messages.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, json, stubFetch, tokenEnvelope } from "./helpers.ts";

const ACTOR = "8ce12a12-4422-4b34-84df-7f808cddf901";
const OTHER = "ac2e902e-7821-44d1-a682-318b4e8fccd0";
const CONVERSATION = "4ab64b35-c524-4349-a35d-811ba9124bde";
const HEADER = "x-expected-messaging-actor";
const KEY = "one-intent-only";
const actions = ["start", "reply", "read"] as const;
type Action = typeof actions[number];

function request(action: Action, options: {
  actor?: string | null; refresh?: boolean; cookie?: string | null;
  method?: string; origin?: string; body?: string;
} = {}): Request {
  const method = options.method ?? (action === "read" ? "PUT" : "POST");
  const suffix = action === "start" ? "" : `/${CONVERSATION}/${action === "read" ? "read" : "messages"}`;
  const headers = new Headers({ origin: options.origin ?? "https://no-wave.test", host: "no-wave.test", "content-type": "application/json" });
  if (options.actor !== null) headers.set(HEADER, options.actor ?? ACTOR);
  if (options.cookie !== null) headers.set("cookie", options.cookie ?? `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}${options.refresh ? `; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}` : ""}`);
  if (action !== "read") headers.set("idempotency-key", KEY);
  return new Request(`https://no-wave.test/api/authoring/inbox${suffix}`, {
    method, headers,
    ...(method === "POST" ? { body: options.body ?? JSON.stringify(action === "start" ? { participantIds: [OTHER] } : { body: "A private message." }) } : {}),
  });
}

function handle(action: Action, req: Request, config: ApiProxyConfig): Promise<Response> {
  if (action === "start") return handleStartConversationRequest(req, config);
  if (action === "reply") return handleSendMessageRequest(req, { conversationId: CONVERSATION }, config);
  return handleConversationReadRequest(req, { conversationId: CONVERSATION }, config);
}

for (const action of actions) {
  test(`${action}: a different verified account cannot consume the original intent`, async () => {
    const stub = stubFetch({
      "api/v1/me": () => json({ data: { id: OTHER } }),
      "api/v1/conversations": () => json({ data: true }, action === "read" ? 200 : 201),
    });
    const response = await handle(action, request(action), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
    assertNoStore(response);
    assert.equal(stub.calls.length, 1, "only the identity check may reach the API");
    assert.equal(stub.calls[0].url, `${API_BASE}/api/v1/me`);
    assert.equal(new Headers(stub.calls[0].init?.headers).get("idempotency-key"), null);
  });

  test(`${action}: the verified token is also the write token, never the browser's claimed identity`, async () => {
    const stub = stubFetch({
      "api/v1/me": () => json({ data: { id: ACTOR } }),
      "api/v1/conversations": () => json({ data: true }, action === "read" ? 200 : 201),
    });
    const response = await handle(action, request(action), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, action === "read" ? 200 : 201);
    assert.deepEqual(await response.json(), { data: true });
    assertNoStore(response);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].url, `${API_BASE}/api/v1/me`);
    const verified = new Headers(stub.calls[0].init?.headers);
    const forwarded = new Headers(stub.calls[1].init?.headers);
    assert.equal(verified.get("authorization"), `Bearer ${TOKENS.accessToken}`);
    assert.equal(forwarded.get("authorization"), verified.get("authorization"));
    assert.equal(forwarded.get(HEADER), null, "the expected account is a restriction, not an API identity header");
    assert.equal(forwarded.get("cookie"), null);
    assert.equal(forwarded.get("idempotency-key"), action === "read" ? null : KEY);
    assert.equal(stub.calls[1].init?.method, action === "read" ? "PUT" : "POST");
  });

  test(`${action}: missing precondition preserves the existing client contract`, async () => {
    const stub = stubFetch({ "api/v1/conversations": () => json({ data: true }) });
    const response = await handle(action, request(action, { actor: null }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assertNoStore(response);
    assert.equal(stub.calls.length, 1, "legacy callers still rely on the API's own membership authorization");
    assert.ok(stub.calls[0].url.includes("/api/v1/conversations"));
  });

  test(`${action}: an unverifiable account fails closed without a write`, async () => {
    for (const payload of [null, [], {}, { data: null }, { data: {} }, { data: { id: "" } }, { data: { id: 3 } }]) {
      const stub = stubFetch({
        "api/v1/me": () => json(payload),
        "api/v1/conversations": () => json({ data: true }),
      });
      const response = await handle(action, request(action), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 502, JSON.stringify(payload));
      assertNoStore(response);
      assert.equal(stub.calls.length, 1);
    }
  });

  test(`${action}: malformed or duplicated expected-account headers never reach upstream`, async () => {
    for (const actor of ["", "x".repeat(301), `${ACTOR},${OTHER}`, `${ACTOR}, ${ACTOR}`, "not an identity", "user\tname"]) {
      const stub = stubFetch({ "api/v1/": () => json({ data: true }) });
      const response = await handle(action, request(action, { actor }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 400, JSON.stringify(actor));
      assertNoStore(response);
      assert.equal(stub.calls.length, 0);
    }
  });

  test(`${action}: origin and method rejection still precede private account validation`, async () => {
    const stub = stubFetch({ "api/v1/": () => json({ data: true }) });
    const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
    const wrongMethod = await handle(action, request(action, { method: "GET", actor: "" }), config);
    assert.equal(wrongMethod.status, 405);
    const foreign = await handle(action, request(action, { origin: "https://other.test", actor: "" }), config);
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).error.code, "ORIGIN_REJECTED");
    assertNoStore(wrongMethod);
    assertNoStore(foreign);
    assert.equal(stub.calls.length, 0);
  });

  test(`${action}: a refresh must verify the new token before it can mutate`, async () => {
    let checks = 0;
    const stub = stubFetch({
      "api/v1/me": () => ++checks === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: OTHER } }),
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
      "api/v1/conversations": () => json({ data: true }),
    });
    const response = await handle(action, request(action, { refresh: true }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
    assertNoStore(response);
    assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${ACCESS_TOKEN_COOKIE}=`)));
    assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), ["/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me"]);
    assert.equal(new Headers(stub.calls[2].init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  });

  test(`${action}: a same-account refresh forwards the exact original payload and key`, async () => {
    let checks = 0;
    const stub = stubFetch({
      "api/v1/me": () => ++checks === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: ACTOR } }),
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
      "api/v1/conversations": () => json({ data: true }),
    });
    const response = await handle(action, request(action, { refresh: true }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assertNoStore(response);
    assert.equal(checks, 2);
    assert.equal(stub.calls.length, 4);
    const write = stub.calls[3];
    const headers = new Headers(write.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${ROTATED.accessToken}`);
    assert.equal(headers.get("idempotency-key"), action === "read" ? null : KEY);
    assert.equal(headers.get(HEADER), null);
    assert.equal(write.init?.body, action === "read" ? undefined : JSON.stringify(action === "start" ? { participantIds: [OTHER] } : { body: "A private message." }));
  });

  test(`${action}: resource expiry cannot bypass account verification on the retry`, async () => {
    let checks = 0;
    let writes = 0;
    const stub = stubFetch({
      "api/v1/me": () => json({ data: { id: ++checks === 1 ? ACTOR : OTHER } }),
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
      "api/v1/conversations": () => { writes++; return json({ error: { code: "UNAUTHENTICATED" } }, 401); },
    });
    const response = await handle(action, request(action, { refresh: true }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 409);
    assert.equal(writes, 1, "the new account must not receive the replay after refresh");
    assert.equal(checks, 2);
    assertNoStore(response);
    assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), ["/api/v1/me", action === "start" ? "/api/v1/conversations" : `/api/v1/conversations/${CONVERSATION}/${action === "read" ? "read" : "messages"}`, "/api/v1/auth/refresh", "/api/v1/me"]);
  });

  test(`${action}: a failed identity lookup is not permission to fall back to an unguarded write`, async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const stub = stubFetch({
        "api/v1/me": () => json({ error: { code: `IDENTITY_${status}` } }, status),
        "api/v1/conversations": () => json({ data: true }),
      });
      const response = await handle(action, request(action), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, status);
      assertNoStore(response);
      assert.equal(stub.calls.length, 1);
    }
  });

  test(`${action}: identity connection failures produce only a bounded private error`, async () => {
    let writes = 0;
    const response = await handle(action, request(action), {
      apiBaseUrl: API_BASE,
      fetchImpl: async (url) => {
        if (url.endsWith("/me")) throw new Error("private details must not be reflected");
        writes++;
        return json({ data: true });
      },
    });
    assert.equal(response.status, 502);
    assertNoStore(response);
    assert.equal(writes, 0);
    assert.doesNotMatch(await response.text(), /private details|Bearer|one-intent-only/);
  });
}

for (const action of actions) {
  test(`${action}: encoded non-ASCII and punctuation-bearing IDs are verified without changing their identity`, async () => {
    for (const actor of ["讀者甲", "reader one", "reader,name", "reader%2Fname", "作家".repeat(150)]) {
      const stub = stubFetch({
        "api/v1/me": () => json({ data: { id: actor } }),
        "api/v1/conversations": () => json({ data: true }),
      });
      const response = await handle(action, request(action, { actor: encodeURIComponent(actor) }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 200, actor);
      assertNoStore(response);
      assert.equal(stub.calls.length, 2, "only exact API identity agreement permits the following write");
      assert.equal(new Headers(stub.calls[1].init?.headers).get(HEADER), null);
    }
  });

  test(`${action}: invalid encodings and encoded padding/control data fail before identity or mutation`, async () => {
    for (const actor of ["%", "%GG", "%C3%28", "%20reader", "reader%20", "reader%00name", "reader%0Aname", encodeURIComponent("讀".repeat(301))]) {
      const stub = stubFetch({ "api/v1/": () => json({ data: true }) });
      const response = await handle(action, request(action, { actor }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
      assert.equal(response.status, 400, actor);
      assertNoStore(response);
      assert.equal(stub.calls.length, 0);
    }
  });
}
