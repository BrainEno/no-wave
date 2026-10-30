import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORING_ARTICLES_LIMIT,
  AUTHORING_BODY_MAX_BYTES,
  authoringArticlePath,
  authoringArticlesPath,
  handleAuthoringArticleRequest,
  handleAuthoringArticlesRequest,
  handleAuthoringSessionRequest,
} from "../src/authoring.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, assertNoStore, json, request, stubFetch } from "./helpers.ts";

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
  const article = await handleAuthoringArticleRequest(
    request(`/api/authoring/articles/${ARTICLE_ID}`, { method: "DELETE", headers: { host: "no-wave.test" } }),
    { id: ARTICLE_ID },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(article.status, 405);
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
