import assert from "node:assert/strict";
import test from "node:test";

import { handleAuthoringProfileRequest } from "../src/profile.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * The writing desk's author-profile proxy. The browser cannot attach the
 * cookie's token itself, so the shared forwarder has to do it; a pen-name edit
 * is a mutation, so an exact same-origin Origin is required before the body is
 * read. Both answers are private and must never be cached.
 */

function upstream(body: unknown = { data: { displayName: "无浪作者", locale: "zh-CN" } }, status = 200) {
  return stubFetch({ "api/v1/me/profile": () => json(body, status) });
}

function readRequest(headers: Record<string, string> = {}): Request {
  return request("/api/authoring/profile", {
    method: "GET",
    headers: { host: "no-wave.test", cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`, ...headers },
  });
}

function writeRequest(body: string, headers: Record<string, string> = {}): Request {
  return request("/api/authoring/profile", {
    method: "PUT",
    body,
    headers: { host: "no-wave.test", origin: "https://no-wave.test", cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`, ...headers },
  });
}

test("GET /api/authoring/profile forwards the cookie token to the API profile", async () => {
  const stub = upstream();
  const response = await handleAuthoringProfileRequest(readRequest(), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0]?.url ?? "", /api\/v1\/me\/profile\?locale=zh-CN$/);
  assert.equal(stub.calls[0]?.init?.method, "GET");
  const headers = new Headers(stub.calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.deepEqual(await response.json(), { data: { displayName: "无浪作者", locale: "zh-CN" } });
});

test("PUT /api/authoring/profile forwards a same-origin pen-name edit", async () => {
  const stub = upstream({ data: { displayName: "新笔名", locale: "zh-CN" } });
  const response = await handleAuthoringProfileRequest(
    writeRequest(JSON.stringify({ displayName: "新笔名", locale: "zh-CN" })),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0]?.url ?? "", /api\/v1\/me\/profile$/);
  assert.equal(stub.calls[0]?.init?.method, "PUT");
  assert.equal(stub.calls[0]?.init?.body, JSON.stringify({ displayName: "新笔名", locale: "zh-CN" }));
});

test("a cross-origin pen-name edit is refused before the API is called", async () => {
  const stub = upstream();
  const response = await handleAuthoringProfileRequest(
    writeRequest(JSON.stringify({ displayName: "x" }), { origin: "https://evil.test" }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ORIGIN_REJECTED");
  assert.equal(stub.calls.length, 0);
});

test("unsupported methods and an unconfigured API are explicit", async () => {
  const stub = upstream();
  const unsupported = await handleAuthoringProfileRequest(
    request("/api/authoring/profile", { method: "DELETE", headers: { host: "no-wave.test", origin: "https://no-wave.test" } }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(unsupported.status, 405);
  assert.equal(stub.calls.length, 0);

  const unavailable = await handleAuthoringProfileRequest(readRequest(), { fetchImpl: stub.fetchImpl });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "SERVICE_UNAVAILABLE");
});
