import assert from "node:assert/strict";
import test from "node:test";

import { conversationReadPath, handleConversationReadRequest } from "../src/messages.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, json, stubFetch, tokenEnvelope } from "./helpers.ts";

const CONVERSATION = "c81407b1-4680-469d-9de4-2c34f042081c";
const SIGNED_IN = `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`;

function request(options: {
  method?: string;
  url?: string;
  origin?: string | null;
  host?: string;
  forwardedProto?: string;
  cookie?: string | null;
} = {}): Request {
  const headers = new Headers({ host: options.host ?? "no-wave.test" });
  if (options.origin !== null) headers.set("origin", options.origin ?? "https://no-wave.test");
  if (options.forwardedProto) headers.set("x-forwarded-proto", options.forwardedProto);
  if (options.cookie !== null) headers.set("cookie", options.cookie ?? SIGNED_IN);
  return new Request(options.url ?? `https://no-wave.test/api/authoring/inbox/${CONVERSATION}/read`, {
    method: options.method ?? "PUT",
    headers,
  });
}

function upstream(body: unknown = { data: true }, status = 200) {
  const stub = stubFetch({ "api/v1/conversations": () => json(body, status) });
  return { calls: stub.calls, config: { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl } };
}

test("marking one conversation read forwards PUT and the session, without a body or an invented key", async () => {
  const { calls, config } = upstream();
  const response = await handleConversationReadRequest(request(), { conversationId: CONVERSATION }, config);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: true });
  assertNoStore(response);
  assert.equal(conversationReadPath(CONVERSATION), `api/v1/conversations/${CONVERSATION}/read`);
  assert.equal(calls[0].url, `${API_BASE}/${conversationReadPath(CONVERSATION)}`);
  assert.equal(calls[0].init?.method, "PUT");
  assert.equal(calls[0].init?.body, undefined);
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("idempotency-key"), null);
});

test("only PUT is accepted and cross-origin is rejected before the id is examined", async () => {
  const { calls, config } = upstream();
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const response = await handleConversationReadRequest(request({ method }), { conversationId: CONVERSATION }, config);
    assert.equal(response.status, 405, method);
    assertNoStore(response);
  }
  for (const origin of [null, "https://other.test", "https://no-wave.test:444", "http://no-wave.test"]) {
    const response = await handleConversationReadRequest(request({ origin }), { conversationId: "not-an-id" }, config);
    assert.equal(response.status, 403, String(origin));
    assert.equal((await response.json()).error.code, "ORIGIN_REJECTED");
  }
  for (const id of ["", "not-an-id", "../read", `${CONVERSATION}x`]) {
    const response = await handleConversationReadRequest(request(), { conversationId: id }, config);
    assert.equal(response.status, 400, id);
    assertNoStore(response);
  }
  assert.equal(calls.length, 0);
});

test("a trusted TLS terminator's protocol permits the external same-origin but not a downgrade", async () => {
  const { calls, config } = upstream();
  const proxy = { url: "http://127.0.0.1:3000/api/authoring/inbox/x/read", host: "reader.example", forwardedProto: "https" };
  const valid = await handleConversationReadRequest(request({ ...proxy, origin: "https://reader.example" }), { conversationId: CONVERSATION }, config);
  assert.equal(valid.status, 200);
  const downgrade = await handleConversationReadRequest(request({ ...proxy, origin: "http://reader.example" }), { conversationId: CONVERSATION }, config);
  assert.equal(downgrade.status, 403);
  const foreign = await handleConversationReadRequest(request({ ...proxy, origin: "https://attacker.example" }), { conversationId: CONVERSATION }, config);
  assert.equal(foreign.status, 403);
  assert.equal(calls.length, 1);
});

test("unauthenticated, forbidden, missing and failing upstream answers pass through rather than claim success", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const body = { error: { code: `ERROR_${status}`, message: "Not marked" } };
    const { calls, config } = upstream(body, status);
    const response = await handleConversationReadRequest(request({ cookie: null }), { conversationId: CONVERSATION }, config);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assertNoStore(response);
    assert.equal(calls.length, 1);
  }
});

test("an expired access token refreshes before retrying the same bodyless PUT", async () => {
  let writes = 0;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/conversations": () => ++writes === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: true }),
  });
  const response = await handleConversationReadRequest(
    request({ cookie: `${SIGNED_IN}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}` }),
    { conversationId: CONVERSATION },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: true });
  assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${ACCESS_TOKEN_COOKIE}=`)));
  const attempts = stub.calls.filter((call) => call.url.endsWith(`/conversations/${CONVERSATION}/read`));
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((call) => call.init?.method), ["PUT", "PUT"]);
  assert.deepEqual(attempts.map((call) => call.init?.body), [undefined, undefined]);
  assert.equal(new Headers(attempts[0].init?.headers).get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(new Headers(attempts[1].init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
});

test("missing or unreachable upstream does not become an acknowledged read", async () => {
  const unavailable = await handleConversationReadRequest(request(), { conversationId: CONVERSATION }, {});
  assert.equal(unavailable.status, 503);
  const disconnected = await handleConversationReadRequest(request(), { conversationId: CONVERSATION }, {
    apiBaseUrl: API_BASE,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(disconnected.status, 502);
  assertNoStore(disconnected);
});
