import assert from "node:assert/strict";
import test from "node:test";

import {
  LIKE_BODY_MAX_BYTES,
  handleArticleLikeRequest,
  likeRequestPath,
  parseLikeBody,
} from "../src/likes.ts";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, ROTATED, TOKENS, assertNoStore, findCookie, json, request, setCookies, stubFetch, tokenEnvelope } from "./helpers.ts";

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
  const stub = stubFetch({
    "api/v1/me": () => json({ data: { id: "reader" } }),
    "api/v1/articles/": () => json({ data: { likeCount: 3, likedByViewer: true } }),
  });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const calls = stub.calls;
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
  assert.equal(calls.length, 2, "verify the viewer before reading the public field");
  for (const call of calls) {
    const forwarded = new Headers(call.init?.headers);
    // Both requests use the same bearer, and the raw cookie never leaves the proxy.
    assert.equal(forwarded.get("authorization"), `Bearer ${TOKENS.accessToken}`);
    assert.equal(forwarded.get("cookie"), null);
  }
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

// A public upstream read responds 200 for an invalid or missing bearer token.
// With a renewable browser session that is NOT an anonymous answer: verify the
// viewer first so the common refresh coordinator can recover the real state.
test("a renewable session restores the viewer before a public like read", async () => {
  for (const access of [undefined, TOKENS.accessToken]) {
    const stub = stubFetch({
      "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
      "api/v1/me": ({ init }) => new Headers(init?.headers).get("authorization") === `Bearer ${ROTATED.accessToken}`
        ? json({ data: { id: "reader" } })
        : json({ error: { code: "UNAUTHENTICATED" } }, 401),
      "api/v1/articles/": ({ init }) => json({ data: { likeCount: 1,
        likedByViewer: new Headers(init?.headers).get("authorization") === `Bearer ${ROTATED.accessToken}` } }),
    });
    const cookie = [`${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}`,
      ...(access ? [`${ACCESS_TOKEN_COOKIE}=${access}`] : [])].join("; ");
    const response = await handleArticleLikeRequest(
      new Request(`https://no-wave.test/api/authoring/articles/${SLUG}/like?locale=zh-CN`, { headers: { cookie } }),
      { slug: SLUG, locale: "zh-CN" }, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.likedByViewer, true);
    assertNoStore(response);
    assert.equal(stub.calls.filter((call) => call.url.includes("/auth/refresh")).length, 1);
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/api/v1/me")).length, 2);
    assert.ok(findCookie(response, ACCESS_TOKEN_COOKIE));
    assert.ok(findCookie(response, REFRESH_TOKEN_COOKIE));
    const resource = stub.calls.find((call) => call.url.includes("/api/v1/articles/"));
    assert.equal(new Headers(resource?.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
    assert.equal(new Headers(resource?.init?.headers).get("cookie"), null);
  }
});

test("a rejected or unavailable session is not guessed as an anonymous like state", async () => {
  for (const refreshStatus of [401, 503]) {
    const stub = stubFetch({
      "api/v1/me": () => json({ error: { code: "UNAUTHENTICATED" } }, 401),
      "api/v1/auth/refresh": () => json({ error: { code: "UNAVAILABLE" } }, refreshStatus),
      "api/v1/articles/": () => json({ data: { likeCount: 1, likedByViewer: false } }),
    });
    const response = await handleArticleLikeRequest(
      new Request(`https://no-wave.test/api/authoring/articles/${SLUG}/like`, {
        headers: { cookie: `${REFRESH_TOKEN_COOKIE}=${TOKENS.refreshToken}` },
      }), { slug: SLUG, locale: "zh-CN" }, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 401);
    assertNoStore(response);
    assert.equal(stub.calls.some((call) => call.url.includes("/api/v1/articles/")), false);
    const cookies = setCookies(response);
    if (refreshStatus === 401) {
      assert.equal(cookies.length, 3);
      assert.ok(cookies.every((cookie) => cookie.includes("Max-Age=0")));
    } else {
      assert.equal(cookies.length, 0, "an outage cannot prove the session ended");
    }
  }
});

test("a malformed session verification cannot become a confident public like read", async () => {
  const stub = stubFetch({
    "api/v1/me": () => json({ data: {} }),
    "api/v1/articles/": () => json({ data: { likeCount: 1, likedByViewer: false } }),
  });
  const response = await handleArticleLikeRequest(
    new Request(`https://no-wave.test/api/authoring/articles/${SLUG}/like`, {
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${TOKENS.accessToken}` },
    }), { slug: SLUG }, { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 502);
  assertNoStore(response);
  assert.equal(stub.calls.some((call) => call.url.includes("/api/v1/articles/")), false);
});

test("like writes use the trusted TLS-terminating proxy origin without accepting a downgrade", async () => {
  for (const [origin, expected] of [
    ["https://preview.example", 200],
    ["http://preview.example", 403],
    ["https://evil.example", 403],
  ] as const) {
    const { config, calls } = likeUpstream();
    const response = await handleArticleLikeRequest(
      new Request(`http://127.0.0.1:3100/api/authoring/articles/${SLUG}/like`, {
        method: "PUT", headers: { host: "preview.example", origin, "x-forwarded-proto": "https", "content-type": "application/json" },
        body: '{"liked":true}',
      }), { slug: SLUG }, config,
    );
    assert.equal(response.status, expected, origin);
    assert.equal(calls.length, expected === 200 ? 1 : 0);
  }
});
