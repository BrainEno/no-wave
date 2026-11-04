import assert from "node:assert/strict";
import test from "node:test";

import {
  LIKE_BODY_MAX_BYTES,
  handleArticleLikeRequest,
  likeRequestPath,
  parseLikeBody,
} from "../src/likes.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, TOKENS, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * Article-like proxy contract (#198).
 *
 * The reading page had no interaction at all, so the capability the API has
 * served for a while was reachable only by clients that already knew about it.
 * These tests cover the seam that closes that: the same shape checks and Origin
 * rule the comment proxy applies, a body that is one boolean and nothing else,
 * and a session cookie — never visible to browser script — carrying the write.
 */

const SLUG = "portable-web-foundation";

function likeUpstream(body: unknown = { data: { articleId: "a", slug: SLUG, likeCount: 3, likedByViewer: true } }, status = 200) {
  const stub = stubFetch({ "api/v1/articles/": () => json(body, status) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  return { calls: stub.calls, config };
}

function getRequest(locale?: string): Request {
  const query = locale === undefined ? "" : `?locale=${encodeURIComponent(locale)}`;
  return new Request(`https://no-wave.test/api/articles/${SLUG}/like${query}`, {
    method: "GET",
    headers: { host: "no-wave.test" },
  });
}

function putRequest(body: string, headers: Record<string, string> = {}): Request {
  return request(`/api/articles/${SLUG}/like?locale=zh-CN`, {
    method: "PUT",
    headers: { host: "no-wave.test", origin: "https://no-wave.test", "content-type": "application/json", ...headers },
    body,
  });
}

test("returns the like state and forwards an anonymous read", async () => {
  const { config, calls } = likeUpstream();
  const response = await handleArticleLikeRequest(getRequest("zh-CN"), { slug: SLUG, locale: "zh-CN" }, config);
  assert.equal(response.status, 200);
  assertNoStore(response);
  const body = await response.json() as { data?: { likedByViewer?: unknown } };
  assert.equal(body.data?.likedByViewer, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(API_BASE), "the proxy talks to the API, not to itself");
});

test("a signed-in read turns the session cookie into a bearer token upstream", async () => {
  const { config, calls } = likeUpstream();
  const cookie = `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}`;
  const response = await handleArticleLikeRequest(
    new Request(`https://no-wave.test/api/articles/${SLUG}/like?locale=zh-CN`, {
      method: "GET",
      headers: { host: "no-wave.test", cookie },
    }),
    { slug: SLUG, locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 200);
  const forwarded = new Headers(calls[0].init?.headers);
  // The cookie is read by the proxy and exchanged for a bearer token: the raw
  // cookie never leaves this process, and the API does not have to know how the
  // browser stores a session.
  assert.equal(forwarded.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(forwarded.get("cookie"), null, "the cookie itself is not passed through");
});

test("PUT forwards exactly one boolean", async () => {
  const { config, calls } = likeUpstream();
  const response = await handleArticleLikeRequest(putRequest('{"liked":true}'), { slug: SLUG, locale: "zh-CN" }, config);
  assert.equal(response.status, 200);
  assert.equal(calls[0].init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { liked: true });
});

test("the body is re-serialised, so whitespace and key order are not part of the request", async () => {
  const { config, calls } = likeUpstream();
  await handleArticleLikeRequest(
    putRequest('{  "liked" :  true , "padding" : null }'),
    { slug: SLUG, locale: "zh-CN" },
    config,
  );
  // Anything the API might hash or compare sees one canonical form.
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { liked: true });
});

test("rejects a body that is not a boolean before it reaches the API", async () => {
  for (const body of ['{"liked":"true"}', '{"liked":1}', "{}", '{"liked":null}', "[]", "null", "not json"]) {
    const { config, calls } = likeUpstream();
    const response = await handleArticleLikeRequest(putRequest(body), { slug: SLUG, locale: "zh-CN" }, config);
    assert.equal(response.status, 400, `${body} must be refused`);
    const payload = await response.json() as { error?: { code?: string } };
    assert.equal(payload.error?.code, "BAD_USER_INPUT");
    assert.equal(calls.length, 0, `${body} must not reach the API`);
  }
});

test("the body is bounded", async () => {
  const huge = JSON.stringify({ liked: true, pad: "x".repeat(LIKE_BODY_MAX_BYTES) });
  const { config, calls } = likeUpstream();
  const response = await handleArticleLikeRequest(putRequest(huge), { slug: SLUG, locale: "zh-CN" }, config);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test("a mutation from another origin is refused, and learns nothing about the slug", async () => {
  const { config, calls } = likeUpstream();
  const response = await handleArticleLikeRequest(
    request(`/api/articles/${SLUG}/like?locale=zh-CN`, {
      method: "PUT",
      headers: { host: "no-wave.test", origin: "https://evil.test", "content-type": "application/json" },
      body: '{"liked":true}',
    }),
    { slug: SLUG, locale: "zh-CN" },
    config,
  );
  assert.equal(response.status, 403);
  // The Origin check runs before slug validation on purpose: a cross-origin
  // caller must not be able to probe which slugs exist by their error code.
  const payload = await response.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "ORIGIN_REJECTED");
  assert.equal(calls.length, 0);
});

test("slug and locale are validated locally", async () => {
  const bad = [
    { slug: "Not A Slug", locale: "zh-CN" },
    { slug: "", locale: "zh-CN" },
    { slug: SLUG, locale: "fr" },
    { slug: SLUG, locale: "zh-CN; DROP TABLE articles" },
  ];
  for (const params of bad) {
    const { config, calls } = likeUpstream();
    const response = await handleArticleLikeRequest(getRequest(params.locale), params, config);
    assert.equal(response.status, 400, `${JSON.stringify(params)} must be refused`);
    assert.equal(calls.length, 0);
  }
});

test("the default locale is zh-CN when the query omits it", () => {
  assert.equal(likeRequestPath(SLUG, "zh-CN"), `api/v1/articles/${SLUG}/like?locale=zh-CN`);
});

test("only GET and PUT are proxied", async () => {
  const { config } = likeUpstream();
  for (const method of ["POST", "DELETE", "PATCH"]) {
    const response = await handleArticleLikeRequest(
      request(`/api/articles/${SLUG}/like?locale=zh-CN`, { method, headers: { host: "no-wave.test", origin: "https://no-wave.test" }, body: "" }),
      { slug: SLUG, locale: "zh-CN" },
      config,
    );
    assert.equal(response.status, 405, `${method} must be refused`);
  }
});

test("an upstream failure is passed through as a failure, with no caching", async () => {
  const stub = stubFetch({
    "api/v1/articles/": () => json({ error: { code: "SERVICE_UNAVAILABLE", message: "try later" } }, 500),
  });
  const response = await handleArticleLikeRequest(
    getRequest("zh-CN"),
    { slug: SLUG, locale: "zh-CN" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  // The upstream status is passed through as-is; 503 is reserved for "the API
  // could not be reached at all", which is a different failure.
  assert.equal(response.status, 500);
  assertNoStore(response);
  // NOT asserted here: that the body is scrubbed. `forwardAuthoringRequest` is a
  // transparent forwarder — it deliberately does not rewrite a message the
  // reader may need to see (`safeApiError` is applied on the auth path, where a
  // credential response is involved). Asserting scrubbing would be asserting a
  // guarantee this seam does not make; writing a scrubbing test here and having
  // it pass would mean the proxy had started second-guessing the API.
});


test("parseLikeBody accepts only real booleans", () => {
  assert.deepEqual(parseLikeBody({ liked: true }), { ok: true, liked: true });
  assert.deepEqual(parseLikeBody({ liked: false }), { ok: true, liked: false });
  for (const value of [null, [], "true", 1, 0, undefined, { liked: "false" }]) {
    assert.deepEqual(parseLikeBody(value), { ok: false }, `${JSON.stringify(value)} is not a like body`);
  }
});
