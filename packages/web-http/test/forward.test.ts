import assert from "node:assert/strict";
import test from "node:test";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, findCookie, json, request, setCookies, stubFetch, tokenEnvelope } from "./helpers.ts";

const sessionCookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${TOKENS.refreshToken}`;

test("the proxy attaches the bearer token from the cookie and forwards the idempotency key", async () => {
  const stub = stubFetch({
    "api/v1/me/articles": () => json({ data: [] }, 200, { "content-type": "application/json; charset=utf-8" }),
  });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", {
      method: "GET",
      headers: { cookie: sessionCookie, "idempotency-key": "idem-123" },
    }),
    "api/v1/me/articles?locale=zh-CN",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(await response.text(), JSON.stringify({ data: [] }));
  assert.equal(stub.calls.length, 1);
  const headers = new Headers(stub.calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(headers.get("idempotency-key"), "idem-123");
  assert.equal(String(stub.calls[0]?.url), `${API_BASE}/api/v1/me/articles?locale=zh-CN`);
});

test("an expired access token is refreshed once, then the request is retried with the new token", async () => {
  let resourceCalls = 0;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me/articles": () => {
      resourceCalls += 1;
      return resourceCalls === 1
        ? json({ error: { code: "TOKEN_EXPIRED", message: "expired" } }, 401)
        : json({ data: [{ id: "article-1" }] });
    },
  });

  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me/articles",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /article-1/);
  assert.equal(resourceCalls, 2, "the resource must be retried exactly once");
  const tokens = stub.calls.filter((call) => call.url.includes("/auth/refresh"));
  assert.equal(tokens.length, 1);
  assert.deepEqual(JSON.parse(String(tokens[0]?.init?.body)), { refreshToken: TOKENS.refreshToken });
  // The retry uses the rotated access token, and the browser receives it as a cookie.
  const retry = stub.calls.filter((call) => call.url.includes("api/v1/me/articles"))[1];
  assert.equal(new Headers(retry?.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.match(findCookie(response, ACCESS_TOKEN_COOKIE) ?? "", new RegExp(`=${ROTATED.accessToken}`));
});

test("a rejected refresh clears the session instead of looping", async () => {
  const stub = stubFetch({
    "api/v1/auth/refresh": () => json({ error: { code: "INVALID_REFRESH_TOKEN", message: "rejected" } }, 401),
    "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED", message: "sign in" } }, 401),
  });

  const response = await forwardAuthoringRequest(
    request("/api/authoring/session", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 401);
  assert.equal(stub.calls.filter((call) => call.url.includes("/auth/refresh")).length, 1);
  const cleared = setCookies(response);
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every((cookie) => /Max-Age=0/.test(cookie)));
});

test("a refresh outage keeps the session cookies intact", async () => {
  const stub = stubFetch({
    "api/v1/auth/refresh": () => json({ error: { code: "SERVICE_UNAVAILABLE", message: "down" } }, 503),
    "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED", message: "sign in" } }, 401),
  });

  const response = await forwardAuthoringRequest(
    request("/api/authoring/session", { method: "GET", headers: { cookie: sessionCookie } }),
    "api/v1/me",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 401);
  assert.equal(
    setCookies(response).length,
    0,
    "a 5xx during refresh proves nothing about the session; clearing it would sign the user out on an outage",
  );
});

test("a 401 without a refresh cookie is passed through unchanged", async () => {
  const stub = stubFetch({
    "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED", message: "sign in" } }, 401),
  });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/session", { method: "GET", headers: { cookie: `nw_access=${TOKENS.accessToken}` } }),
    "api/v1/me",
    "GET",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 401);
  assert.equal(stub.calls.length, 1);
  assert.equal(setCookies(response).length, 0);
});

test("an unreachable API and a missing origin are reported explicitly", async () => {
  const unreachable = await forwardAuthoringRequest(
    request("/api/authoring/session", { method: "GET" }),
    "api/v1/me",
    "GET",
    {
      apiBaseUrl: API_BASE,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  );
  assert.equal(unreachable.status, 502);
  assert.match(await unreachable.text(), /could not be reached/);

  const unconfigured = await forwardAuthoringRequest(
    request("/api/authoring/session", { method: "GET" }),
    "api/v1/me",
    "GET",
    {},
  );
  assert.equal(unconfigured.status, 503);
  assertNoStore(unconfigured);
});

test("a write body and content type are forwarded verbatim", async () => {
  const stub = stubFetch({ "api/v1/me/media": () => json({ data: { id: "media-1" } }) });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await forwardAuthoringRequest(
    request("/api/authoring/media", { method: "POST", headers: { cookie: sessionCookie } }),
    "api/v1/me/media",
    "POST",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    bytes,
    "image/png",
  );
  const headers = new Headers(stub.calls[0]?.init?.headers);
  assert.equal(headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await new Response(stub.calls[0]?.init?.body as BodyInit).arrayBuffer()), bytes);
});

test("the upstream status and content type survive, but the cache policy does not", async () => {
  const stub = stubFetch({
    "api/v1/articles/article-1": () => json({ error: { code: "NOT_FOUND", message: "nope" } }, 404, {
      "content-type": "application/problem+json",
      "cache-control": "public, max-age=600",
    }),
  });
  const response = await forwardAuthoringRequest(
    request("/api/authoring/articles/article-1", { method: "PUT", headers: { cookie: sessionCookie }, body: "{}" }),
    "api/v1/articles/article-1",
    "PUT",
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    "{}",
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("cache-control")?.includes("max-age=600"), false);
});

test("no Authorization header is sent when the access cookie is absent", async () => {
  const stub = stubFetch({ "api/v1/me": () => json({ data: {} }) });
  await forwardAuthoringRequest(request("/api/authoring/session", { method: "GET" }), "api/v1/me", "GET", {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  const headers = new Headers(stub.calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("idempotency-key"), null);
});
