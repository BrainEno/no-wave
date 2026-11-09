import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORING_ARTICLES_LIMIT,
  AUTHORING_BODY_MAX_BYTES,
  authoringArticlePath,
  authoringArticlesPath,
  authoringDeletedArticlesPath,
  authoringNotionExportPath,
  authoringRestoreArticlePath,
  handleAuthoringArticleRequest,
  handleAuthoringArticlesRequest,
  handleAuthoringDeletedArticlesRequest,
  handleAuthoringNotionExportRequest,
  handleAuthoringRestoreRequest,
  handleAuthoringSessionRequest,
} from "../src/authoring.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, json, request, stubFetch, tokenEnvelope } from "./helpers.ts";

/**
 * Writing-desk proxy contract (Phase 4b).
 *
 * These are the properties that decide whether the desk works after hydration or
 * only looks right: the session call forwards the HttpOnly cookie as the
 * `Authorization` header (the browser cannot do it itself), a mutation only
 * crosses the proxy from our own origin, an article id is shape-checked before it
 * is forwarded, the body is bounded, and every answer is uncacheable.
 *
 * The Origin check is asserted to run *before* the id is validated: otherwise a
 * cross-origin caller could use the status code to probe which ids exist.
 */

const ARTICLE_ID = "3f7c1d90-8a2b-4c1e-9f3a-6c5b2e8d1a44";

function upstream(body: unknown = { data: [] }, status = 200) {
  return stubFetch({ "api/v1/": () => json(body, status) });
}

function deleteRequest(id: string, headers: Record<string, string> = {}): Request {
  return request(`/api/authoring/articles/${id}`, {
    method: "DELETE",
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

function restoreRequest(id: string, headers: Record<string, string> = {}): Request {
  return request(`/api/authoring/articles/${id}/restore`, {
    method: "POST",
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

function trashRequest(method = "GET", headers: Record<string, string> = {}): Request {
  return request("/api/authoring/deleted-articles", {
    method,
    headers: { host: "no-wave.test", ...headers },
  });
}

function exportRequest(query: string, method = "GET"): Request {
  return request(`/api/authoring/notion-export${query}`, { method, headers: { host: "no-wave.test" } });
}

function sessionRequest(method = "GET", headers: Record<string, string> = {}): Request {
  return request("/api/authoring/session", { method, headers: { host: "no-wave.test", ...headers } });
}

function listRequest(): Request {
  return request("/api/authoring/articles", { method: "GET", headers: { host: "no-wave.test" } });
}

function createRequest(body: string, headers: Record<string, string> = {}): Request {
  return request("/api/authoring/articles", {
    method: "POST",
    body,
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

function updateRequest(id: string, body: string, headers: Record<string, string> = {}): Request {
  return request(`/api/authoring/articles/${id}`, {
    method: "PUT",
    body,
    headers: { host: "no-wave.test", origin: "https://no-wave.test", ...headers },
  });
}

test("the session is read from the API with the cookie's token, never a token the script can see", async () => {
  const stub = upstream({ data: { userId: "writer", displayName: "林可行" } });
  const response = await handleAuthoringSessionRequest(
    sessionRequest("GET", { cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}` }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/me`);
  assert.equal(
    (stub.calls[0]?.init?.headers as Headers).get("authorization"),
    `Bearer ${TOKENS.accessToken}`,
    "the access token must be attached server-side from the HttpOnly cookie",
  );
});

test("a signed-out session is a 401 the desk can render, not an error page", async () => {
  const stub = upstream({ error: { code: "UNAUTHENTICATED" } }, 401);
  const response = await handleAuthoringSessionRequest(sessionRequest(), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 401);
  assertNoStore(response);
});

test("only the documented methods reach the session endpoint", async () => {
  const stub = upstream();
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await handleAuthoringSessionRequest(sessionRequest(method), {
      apiBaseUrl: API_BASE,
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(response.status, 405, `${method} must not proxy the session`);
  }
  assert.deepEqual(stub.calls, []);
});

test("the desk lists the author's work from one bounded upstream path", async () => {
  const stub = upstream({ data: [{ id: ARTICLE_ID, title: "无浪文学的第一篇文章" }] });
  const response = await handleAuthoringArticlesRequest(listRequest(), {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringArticlesPath()}`);
  assert.match(stub.calls[0]?.url ?? "", new RegExp(`limit=${AUTHORING_ARTICLES_LIMIT}$`));
});

test("an unconfigured API is a 503 that never reaches the network", async () => {
  const stub = upstream();
  for (const handler of [
    () => handleAuthoringSessionRequest(sessionRequest(), { apiBaseUrl: undefined, fetchImpl: stub.fetchImpl }),
    () => handleAuthoringArticlesRequest(listRequest(), { apiBaseUrl: undefined, fetchImpl: stub.fetchImpl }),
  ]) {
    assert.equal((await handler()).status, 503);
  }
  assert.deepEqual(stub.calls, []);
});

test("a new work is only accepted from our own origin", async () => {
  const body = JSON.stringify({ title: "无浪文学的第一篇文章", editorState: { root: { children: [] } } });
  const allowed = upstream({ data: { id: ARTICLE_ID, slug: "a-slug" } }, 201);
  const same = await handleAuthoringArticlesRequest(createRequest(body), {
    apiBaseUrl: API_BASE,
    fetchImpl: allowed.fetchImpl,
  });
  assert.equal(same.status, 201);
  assertNoStore(same);
  assert.equal(allowed.calls[0]?.url, `${API_BASE}/api/v1/articles`);
  assert.equal(allowed.calls[0]?.init?.method, "POST");
  assert.equal(allowed.calls[0]?.init?.body, body, "the body is relayed unchanged");

  const stub = upstream({ data: { id: ARTICLE_ID } }, 201);
  const cross = await handleAuthoringArticlesRequest(
    createRequest(body, { origin: "https://evil.test" }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(cross.status, 403);
  assert.equal((await cross.json() as { error: { code: string } }).error.code, "ORIGIN_REJECTED");
  assert.deepEqual(stub.calls, [], "a rejected origin must not reach the API");
});

test("saving an existing work is an update against its own id", async () => {
  const body = JSON.stringify({ title: "无浪文学的第一篇文章", publish: true });
  const stub = upstream({ data: { id: ARTICLE_ID, status: "published" } });
  const response = await handleAuthoringArticleRequest(
    updateRequest(ARTICLE_ID, body),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringArticlePath(ARTICLE_ID)}`);
  assert.equal(stub.calls[0]?.init?.method, "PUT");
});

test("a malformed article id is a local 400, and the origin check still comes first", async () => {
  const stub = upstream();
  for (const id of ["not-a-uuid", "..%2Fetc", "12345", ""]) {
    const response = await handleAuthoringArticleRequest(
      updateRequest(id, "{}"),
      { id },
      { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 400, `${id} must be rejected locally`);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "BAD_USER_INPUT");
  }

  // The order is the point: a cross-origin request must not learn whether the id
  // it guessed exists, so it is refused for its origin, not for the id.
  const cross = await handleAuthoringArticleRequest(
    updateRequest("not-a-uuid", "{}", { origin: "https://evil.test" }),
    { id: "not-a-uuid" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(cross.status, 403);
  assert.deepEqual(stub.calls, []);
});

test("only the documented methods reach the article endpoints", async () => {
  const stub = upstream();
  const list = await handleAuthoringArticlesRequest(
    request("/api/authoring/articles", { method: "DELETE", headers: { host: "no-wave.test" } }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(list.status, 405);
  // DELETE is a documented method on a work, PUT is not on the collection, and
  // PATCH is documented nowhere: it must never reach the API.
  const article = await handleAuthoringArticleRequest(
    request(`/api/authoring/articles/${ARTICLE_ID}`, { method: "PATCH", headers: { host: "no-wave.test" } }),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(article.status, 405);
  assert.deepEqual(stub.calls, []);
});

test("deleting a work is a body-less DELETE that only leaves our own origin", async () => {
  const stub = upstream({ data: { id: ARTICLE_ID, deletedAt: "2026-01-02T03:04:05.678Z" } });
  const deleted = await handleAuthoringArticleRequest(
    deleteRequest(ARTICLE_ID),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(deleted.status, 200);
  assertNoStore(deleted);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringArticlePath(ARTICLE_ID)}`);
  assert.equal(stub.calls[0]?.init?.method, "DELETE");
  assert.equal(stub.calls[0]?.init?.body, undefined, "a delete carries no body");

  const stub2 = upstream({ data: { id: ARTICLE_ID } });
  const cross = await handleAuthoringArticleRequest(
    deleteRequest(ARTICLE_ID, { origin: "https://evil.test" }),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub2.fetchImpl },
  );
  assert.equal(cross.status, 403);
  assert.equal((await cross.json() as { error: { code: string } }).error.code, "ORIGIN_REJECTED");
  assert.deepEqual(stub2.calls, [], "a foreign origin must not delete a work");

  // Same order as a save: the origin is refused before the id is inspected, so a
  // cross-origin caller cannot learn which ids exist from the status code.
  const both = await handleAuthoringArticleRequest(
    deleteRequest("not-a-uuid", { origin: "https://evil.test" }),
    { id: "not-a-uuid" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(both.status, 403);
});

test("the recycle bin is a no-store read of the author's own tombstones", async () => {
  const stub = upstream({ data: [{ id: ARTICLE_ID, deletedAt: "2026-01-02T03:04:05.678Z", purgesAt: "2026-02-01T03:04:05.678Z" }] });
  const listed = await handleAuthoringDeletedArticlesRequest(
    trashRequest(),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(listed.status, 200);
  assertNoStore(listed);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringDeletedArticlesPath()}`);
  assert.equal(stub.calls[0]?.init?.method, "GET");
  assert.deepEqual(await listed.json(), { data: [{ id: ARTICLE_ID, deletedAt: "2026-01-02T03:04:05.678Z", purgesAt: "2026-02-01T03:04:05.678Z" }] });

  // A read that is also a write: only GET is documented here.
  const write = await handleAuthoringDeletedArticlesRequest(
    trashRequest("DELETE"),
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(write.status, 405);
});

test("restoring a work is a body-less POST that only leaves our own origin", async () => {
  const stub = upstream({ data: { id: ARTICLE_ID, status: "draft" } });
  const restored = await handleAuthoringRestoreRequest(
    restoreRequest(ARTICLE_ID),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(restored.status, 200);
  assertNoStore(restored);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringRestoreArticlePath(ARTICLE_ID)}`);
  assert.equal(stub.calls[0]?.init?.method, "POST");
  assert.equal(stub.calls[0]?.init?.body, undefined, "a restore carries no body");

  const stub2 = upstream({ data: { id: ARTICLE_ID } });
  const cross = await handleAuthoringRestoreRequest(
    restoreRequest(ARTICLE_ID, { origin: "https://evil.test" }),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub2.fetchImpl },
  );
  assert.equal(cross.status, 403);
  assert.equal((await cross.json() as { error: { code: string } }).error.code, "ORIGIN_REJECTED");
  assert.deepEqual(stub2.calls, [], "a foreign origin must not restore a work");

  // The id is checked only after the origin, as it is for a save and a delete.
  const both = await handleAuthoringRestoreRequest(
    restoreRequest("not-a-uuid", { origin: "https://evil.test" }),
    { id: "not-a-uuid" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(both.status, 403);

  const malformed = await handleAuthoringRestoreRequest(
    restoreRequest("not-a-uuid"),
    { id: "not-a-uuid" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "BAD_USER_INPUT");
});

test("only POST reaches the restore endpoint", async () => {
  const stub = upstream();
  const response = await handleAuthoringRestoreRequest(
    request(`/api/authoring/articles/${ARTICLE_ID}/restore`, { method: "GET", headers: { host: "no-wave.test" } }),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 405);
  assert.deepEqual(stub.calls, []);
});

test("an oversized body is refused before it is forwarded", async () => {
  const oversized = JSON.stringify({ editorState: { root: { children: [] } }, pad: "x".repeat(AUTHORING_BODY_MAX_BYTES) });
  assert.ok(oversized.length > AUTHORING_BODY_MAX_BYTES, "the fixture must exceed the ceiling");

  const create = upstream();
  const created = await handleAuthoringArticlesRequest(createRequest(oversized), {
    apiBaseUrl: API_BASE,
    fetchImpl: create.fetchImpl,
  });
  assert.equal(created.status, 413);

  const update = upstream();
  const updated = await handleAuthoringArticleRequest(
    updateRequest(ARTICLE_ID, oversized),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: update.fetchImpl },
  );
  assert.equal(updated.status, 413);
  assert.deepEqual([...create.calls, ...update.calls], []);
});

test("a non-JSON body is refused with 415 instead of being relayed", async () => {
  const stub = upstream();
  const response = await handleAuthoringArticlesRequest(
    request("/api/authoring/articles", {
      method: "POST",
      body: "title=",
      headers: { host: "no-wave.test", "content-type": "text/plain" },
    }),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 415);
  assert.deepEqual(stub.calls, []);
});

const EXPECTED_AUTHOR_HEADER = "x-expected-author";
const ORIGINAL_AUTHOR = "writer-original";

test("an expected author is checked with the same credential used for the create", async () => {
  const body = '{"title":"one"}';
  const stub = stubFetch({
    "api/v1/me": () => json({ data: { id: ORIGINAL_AUTHOR } }),
    "api/v1/articles": () => json({ data: { id: ARTICLE_ID } }, 201),
  });
  const response = await handleAuthoringArticlesRequest(createRequest(body, {
    cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`,
    [EXPECTED_AUTHOR_HEADER]: ORIGINAL_AUTHOR,
    "idempotency-key": "retry-key",
  }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 201);
  assertNoStore(response);
  assert.deepEqual(stub.calls.map((call) => call.url), [`${API_BASE}/api/v1/me`, `${API_BASE}/api/v1/articles`]);
  const identityHeaders = new Headers(stub.calls[0]?.init?.headers);
  const createHeaders = new Headers(stub.calls[1]?.init?.headers);
  assert.equal(identityHeaders.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(createHeaders.get("authorization"), identityHeaders.get("authorization"));
  assert.equal(createHeaders.get("idempotency-key"), "retry-key");
  assert.equal(createHeaders.get(EXPECTED_AUTHOR_HEADER), null);
  assert.equal(stub.calls[1]?.init?.body, body);
});

test("an account change or unreadable identity never sends the create", async () => {
  for (const [identity, expectedStatus, expectedCode] of [
    [{ data: { id: "other-writer" } }, 409, "ACCOUNT_CHANGED"],
    [{ data: {} }, 502, "SERVICE_UNAVAILABLE"],
  ] as const) {
    const stub = stubFetch({
      "api/v1/me": () => json(identity),
      "api/v1/articles": () => json({ data: { id: ARTICLE_ID } }, 201),
    });
    const response = await handleAuthoringArticlesRequest(createRequest('{"title":"one"}', {
      cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`,
      [EXPECTED_AUTHOR_HEADER]: ORIGINAL_AUTHOR,
    }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, expectedStatus);
    assertNoStore(response);
    assert.equal((await response.json() as { error: { code: string } }).error.code, expectedCode);
    assert.equal(stub.calls.length, 1, "an unverified or different account must never reach the article API");
    assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/me`);
  }
});

test("after refresh the expected author is checked again using the exact new create credential", async () => {
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me": (call) => new Headers(call.init?.headers).get("authorization") === `Bearer ${TOKENS.accessToken}`
      ? json({ error: { code: "UNAUTHENTICATED" } }, 401)
      : json({ data: { id: ORIGINAL_AUTHOR } }),
    "api/v1/articles": () => json({ data: { id: ARTICLE_ID } }, 201),
  });
  const response = await handleAuthoringArticlesRequest(createRequest('{"title":"one"}', {
    cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`,
    [EXPECTED_AUTHOR_HEADER]: ORIGINAL_AUTHOR,
    "idempotency-key": "retry-key",
  }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 201);
  assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), [
    "/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me", "/api/v1/articles",
  ]);
  assert.equal(new Headers(stub.calls[2]?.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(new Headers(stub.calls[3]?.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(new Headers(stub.calls[3]?.init?.headers).get("idempotency-key"), "retry-key");
  assert.ok(response.headers.getSetCookie().length > 0, "rotated session reaches the browser");
});

test("a 401 from the create itself refreshes and rechecks the author before retrying", async () => {
  let creates = 0;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me": () => json({ data: { id: ORIGINAL_AUTHOR } }),
    "api/v1/articles": () => ++creates === 1
      ? json({ error: { code: "UNAUTHENTICATED" } }, 401)
      : json({ data: { id: ARTICLE_ID } }, 201),
  });
  const response = await handleAuthoringArticlesRequest(createRequest('{"title":"one"}', {
    cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`,
    [EXPECTED_AUTHOR_HEADER]: ORIGINAL_AUTHOR,
    "idempotency-key": "retry-key",
  }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 201);
  assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), [
    "/api/v1/me", "/api/v1/articles", "/api/v1/auth/refresh", "/api/v1/me", "/api/v1/articles",
  ]);
  assert.equal(new Headers(stub.calls[3]?.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(new Headers(stub.calls[4]?.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(new Headers(stub.calls[4]?.init?.headers).get("idempotency-key"), "retry-key");
  assert.ok(response.headers.getSetCookie().length > 0);
});

test("if refreshed credentials belong to another account, no create is sent", async () => {
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me": (call) => new Headers(call.init?.headers).get("authorization") === `Bearer ${TOKENS.accessToken}`
      ? json({ error: { code: "UNAUTHENTICATED" } }, 401)
      : json({ data: { id: "other-writer" } }),
    "api/v1/articles": () => json({ data: { id: ARTICLE_ID } }, 201),
  });
  const response = await handleAuthoringArticlesRequest(createRequest('{"title":"one"}', {
    cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}; ${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`,
    [EXPECTED_AUTHOR_HEADER]: ORIGINAL_AUTHOR,
  }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "ACCOUNT_CHANGED");
  assert.deepEqual(stub.calls.map((call) => new URL(call.url).pathname), [
    "/api/v1/me", "/api/v1/auth/refresh", "/api/v1/me",
  ]);
  assert.ok(response.headers.getSetCookie().length > 0);
});

test("malformed expected-author preconditions are rejected before contacting the API", async () => {
  for (const value of ["", "%", "x".repeat(301), "%20writer"]) {
    const stub = upstream();
    const response = await handleAuthoringArticlesRequest(createRequest('{"title":"one"}', {
      [EXPECTED_AUTHOR_HEADER]: value,
    }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 400);
    assertNoStore(response);
    assert.deepEqual(stub.calls, []);
  }
});

test("only local pre-forward rejections attest that the create was never sent", async () => {
  const stub = upstream();
  const invalidJson = await handleAuthoringArticlesRequest(createRequest("not json"), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.headers.get("x-authoring-not-forwarded"), "1");
  const oversized = await handleAuthoringArticlesRequest(createRequest(JSON.stringify({ text: "x".repeat(AUTHORING_BODY_MAX_BYTES + 1) })), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("x-authoring-not-forwarded"), "1");
  assert.deepEqual(stub.calls, []);

  const untrusted = stubFetch({
    "api/v1/articles": () => json({ error: { code: "BAD_USER_INPUT" } }, 400, { "x-authoring-not-forwarded": "1" }),
  });
  const proxied = await handleAuthoringArticlesRequest(createRequest('{"title":"one"}'), { apiBaseUrl: API_BASE, fetchImpl: untrusted.fetchImpl });
  assert.equal(proxied.status, 400);
  assert.equal(proxied.headers.get("x-authoring-not-forwarded"), null, "an upstream response cannot attest the proxy did not send it");
  assert.equal(untrusted.calls.length, 1);
});

test("the desk can request all language editions without changing the existing default", async () => {
  for (const [path, expected] of [
    ["/api/authoring/articles?allLocales=true", "api/v1/me/articles?allLocales=true&limit=100"],
    ["/api/authoring/deleted-articles?allLocales=true", "api/v1/me/articles/deleted?allLocales=true&limit=100"],
    ["/api/authoring/articles?locale=en", "api/v1/me/articles?locale=en&limit=100"],
    ["/api/authoring/deleted-articles?locale=zh-TW", "api/v1/me/articles/deleted?locale=zh-TW&limit=100"],
  ] as const) {
    const stub = upstream();
    const handler = path.includes("deleted-articles") ? handleAuthoringDeletedArticlesRequest : handleAuthoringArticlesRequest;
    const response = await handler(request(path, { method: "GET", headers: { host: "no-wave.test", cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}` } }),
      { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 200);
    assertNoStore(response);
    assert.equal(stub.calls[0]?.url, `${API_BASE}/${expected}`);
    assert.equal(new Headers(stub.calls[0]?.init?.headers).get("authorization"), `Bearer ${TOKENS.accessToken}`);
  }
});

test("invalid or ambiguous list language options are rejected before proxying", async () => {
  for (const path of [
    "/api/authoring/articles?locale=fr", "/api/authoring/articles?locale=all",
    "/api/authoring/articles?allLocales=false", "/api/authoring/articles?allLocales=true&locale=en",
    "/api/authoring/articles?locale=en&locale=zh-CN",
    "/api/authoring/deleted-articles?allLocales=true&allLocales=true",
    "/api/authoring/deleted-articles?locale=", "/api/authoring/deleted-articles?locale=zh-tw",
  ]) {
    const stub = upstream();
    const handler = path.includes("deleted-articles") ? handleAuthoringDeletedArticlesRequest : handleAuthoringArticlesRequest;
    const response = await handler(request(path, { method: "GET", headers: { host: "no-wave.test" } }), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
    assert.equal(response.status, 400, path);
    assertNoStore(response);
    assert.deepEqual(stub.calls, [], path);
  }
});

test("restoring a specific edition forwards its actual locale, without weakening origin or id checks", async () => {
  for (const locale of ["en", "zh-TW", "zh-CN"]) {
    const stub = upstream({ data: { id: ARTICLE_ID, locale, status: "draft" } });
    const response = await handleAuthoringRestoreRequest(
      request(`/api/authoring/articles/${ARTICLE_ID}/restore?locale=${locale}`, {
        method: "POST", headers: { host: "no-wave.test", origin: "https://no-wave.test" },
      }), { id: ARTICLE_ID }, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 200);
    assertNoStore(response);
    assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/articles/${ARTICLE_ID}/restore?locale=${locale}`);
    assert.equal(stub.calls[0]?.init?.body, undefined);
  }
  for (const query of ["locale=fr", "locale=", "locale=en&locale=zh-CN", "allLocales=true"]) {
    const stub = upstream();
    const response = await handleAuthoringRestoreRequest(
      request(`/api/authoring/articles/${ARTICLE_ID}/restore?${query}`, {
        method: "POST", headers: { host: "no-wave.test", origin: "https://no-wave.test" },
      }), { id: ARTICLE_ID }, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 400, query);
    assert.deepEqual(stub.calls, []);
  }
  const cross = await handleAuthoringRestoreRequest(
    request(`/api/authoring/articles/bad/restore?locale=fr`, {
      method: "POST", headers: { host: "no-wave.test", origin: "https://evil.test" },
    }), { id: "bad" }, { apiBaseUrl: API_BASE, fetchImpl: upstream().fetchImpl },
  );
  assert.equal(cross.status, 403);
});

test("the Notion export downloads the bundle instead of rendering it", async () => {
  const bundle = { version: 1, database: { id: "", title: "no-wave export" }, pages: [{ id: "site:article-1:zh-CN", properties: {}, blocks: [] }] };
  const stub = upstream({ data: { bundle, report: { works: [], missing: [], summary: { works: 0, pages: 1, missing: 0 } } } });

  const exported = await handleAuthoringNotionExportRequest(
    exportRequest("?slugs=qiangbi,cai-diao"),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );

  assert.equal(exported.status, 200);
  assertNoStore(exported);
  // The one thing this route adds to the shared forwarder: the browser saves the
  // answer, because a bundle the author has to copy out of a JSON viewer is not a
  // download.
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="notion-bundle\.json"$/);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/${authoringNotionExportPath(["qiangbi", "cai-diao"])}`);
  assert.equal(stub.calls[0]?.init?.method, "GET");
  assert.deepEqual(await exported.json(), { data: { bundle, report: { works: [], missing: [], summary: { works: 0, pages: 1, missing: 0 } } } });
});

test("an export names at most fifty works, and only addresses", async () => {
  const stub = upstream();
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };

  // No parameter, an empty one, and a duplicate parameter: all answered locally.
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest(""), config)).status, 400);
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest("?slugs="), config)).status, 400);
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest("?slugs=a&slugs=b"), config)).status, 400);
  // A title is not an address, and the proxy says so without asking the API.
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest("?slugs=%E5%A2%99%E5%A3%81"), config)).status, 400);
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest("?slugs=Qiangbi"), config)).status, 400);
  const tooMany = Array.from({ length: 51 }, (_, index) => `work-${index}`).join(",");
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest(`?slugs=${tooMany}`), config)).status, 400);
  assert.equal((await handleAuthoringNotionExportRequest(exportRequest("?slugs=qiangbi", "POST"), config)).status, 405);
  assert.equal(stub.calls.length, 0, "a refused export never reaches the network");

  // The fifty-first work is the one that is refused, not the fiftieth.
  const allowed = Array.from({ length: 50 }, (_, index) => `work-${index}`).join(",");
  const accepted = await handleAuthoringNotionExportRequest(exportRequest(`?slugs=${allowed}`), config);
  assert.equal(accepted.status, 200);
});

test("a failed export keeps the API's error instead of saving it as a file", async () => {
  const stub = upstream({ error: { code: "UNAUTHENTICATED", message: "Authentication is required." } }, 401);
  const refused = await handleAuthoringNotionExportRequest(
    exportRequest("?slugs=qiangbi"),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("content-disposition"), null);
  assert.deepEqual(await refused.json(), { error: { code: "UNAUTHENTICATED", message: "Authentication is required." } });
});
