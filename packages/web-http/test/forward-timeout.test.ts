import assert from "node:assert/strict";
import test from "node:test";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, findCookie, json, request, setCookies, stubFetch, tokenEnvelope } from "./helpers.ts";

/**
 * The Web tier's upstream budget (audit F-17).
 *
 * These tests drive the real forwarder against transports that never answer, so
 * they prove the deployment shape rather than the helper in isolation: a hung
 * API must produce a bounded, cache-safe answer instead of a pinned request.
 */

const sessionCookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${TOKENS.refreshToken}`;

/** A transport that never settles and never reads the abort signal. */
function hanging(): Promise<Response> {
  return new Promise<Response>(() => {});
}

test("a hung upstream answers 504 within the budget instead of holding the request", async () => {
  const stub = stubFetch({ "api/v1/me/articles": hanging });
  const started = Date.now();
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles?locale=zh-CN",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: 40 },
  );
  const elapsed = Date.now() - started;

  assert.equal(response.status, 504);
  assertNoStore(response);
  const payload = (await response.json()) as { error?: { code?: string; message?: string } };
  assert.equal(payload.error?.code, "UPSTREAM_TIMEOUT");
  // The public error boundary renders this message: it may not leak the origin,
  // the path, a header or a credential.
  assert.equal(/api\.example\.test|Bearer|access-token/.test(payload.error?.message ?? ""), false);
  assert.ok(elapsed < 2_000, `the deadline must end the call, elapsed ${elapsed} ms`);
  assert.equal(stub.calls.length, 1, "a timed-out call must not be retried");
});

test("the budget also covers a body that never finishes", async () => {
  const stub = stubFetch({
    "api/v1/me/articles": () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          // Never closes: headers arrived, the body did not.
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: 60 },
  );

  assert.equal(response.status, 504);
  assertNoStore(response);
});

test("a connection failure stays a 502, not a timeout", async () => {
  const stub = stubFetch({ "api/v1/me/articles": () => Promise.reject(new TypeError("fetch failed")) });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: 500 },
  );

  assert.equal(response.status, 502);
  assert.equal(setCookies(response).length, 0);
});

test("a timeout after a rotation still hands the browser the new cookies", async () => {
  // The first call rotates the session; the retry then times out. Dropping the
  // rotation would leave the browser holding a token pair the API has already
  // revoked, so the rotation must survive the failure.
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me/articles": () => json({ error: { code: "TOKEN_EXPIRED", message: "expired" } }, 401),
  }, () => json({ error: { code: "TOKEN_EXPIRED", message: "expired" } }, 401));

  let calls = 0;
  const transport = {
    calls: stub.calls,
    async fetchImpl(input: string, init?: RequestInit): Promise<Response> {
      stub.calls.push({ url: input, init });
      calls += 1;
      if (input.includes("api/v1/auth/refresh")) return tokenEnvelope(ROTATED);
      if (calls === 1) return json({ error: { code: "TOKEN_EXPIRED", message: "expired" } }, 401);
      return hanging();
    },
  };

  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: transport.fetchImpl, upstreamTimeoutMs: 40 },
  );

  assert.equal(response.status, 504);
  const access = findCookie(response, ACCESS_TOKEN_COOKIE);
  const refresh = findCookie(response, REFRESH_TOKEN_COOKIE);
  assert.ok(access?.includes(ROTATED.accessToken), "the rotated access token must be set");
  assert.ok(refresh?.includes(ROTATED.refreshToken), "the rotated refresh token must be set");
});

test("a hung refresh passes the original 401 through and keeps the session cookies", async () => {
  const stub = stubFetch({
    "api/v1/auth/refresh": hanging,
    "api/v1/me/articles": () => json({ error: { code: "TOKEN_EXPIRED", message: "expired" } }, 401),
  });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: 40 },
  );

  // A refresh that did not answer proves nothing about the session: the caller
  // sees the original 401 and the browser keeps its cookies.
  assert.equal(response.status, 401);
  assert.deepEqual(setCookies(response), []);
});

test("a successful call inside the budget is unaffected", async () => {
  const stub = stubFetch({ "api/v1/me/articles": () => json({ data: [] }) });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: 5_000 },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({ data: [] }));
});

test("a malformed budget fails closed instead of becoming an unbounded wait", async () => {
  const stub = stubFetch({ "api/v1/me/articles": () => json({ data: [] }) });
  for (const invalid of [0, -1, 2.5, "soon", 999_999]) {
    const response = await forwardAuthoringRequest(
      request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
      "api/v1/me/articles",
      "GET",
      { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, upstreamTimeoutMs: invalid },
    );
    assert.equal(response.status, 503, `budget ${JSON.stringify(invalid)} must be rejected`);
    assertNoStore(response);
  }
  assert.equal(stub.calls.length, 0, "a rejected budget must not reach the API");
});
