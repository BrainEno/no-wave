import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMENT_BODY_MAX_BYTES,
  COMMENT_PAGE_LIMIT,
  commentsRequestPath,
  handleArticleCommentsRequest,
} from "../src/comments.ts";
import { ACCESS_TOKEN_COOKIE } from "../src/policy.ts";
import { API_BASE, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * Article-comments proxy contract (Phase 4a).
 *
 * The properties under test are the ones that make the difference between a
 * comment section that works after hydration and one that only looks right in
 * the HTML: the slug/locale shape is checked locally instead of being forwarded,
 * a mutation only crosses the proxy from our own origin, the body is bounded,
 * the caller's session cookie — never visible to browser script — is what
 * authorizes the write, and an upstream failure is sanitized.
 */

const SLUG = "portable-web-foundation";

function commentsUpstream(body: unknown = { data: [] }, status = 200) {
  return stubFetch({ "api/v1/articles/": () => json(body, status) });
}

function listRequest(locale?: string): Request {
  const query = locale === undefined ? "" : `?locale=${encodeURIComponent(locale)}`;
  return new Request(`https://no-wave.test/api/articles/${SLUG}/comments${query}`, {
    method: "GET",
    headers: { host: "no-wave.test" },
  });
}

function postRequest(body: string, headers: Record<string, string> = {}): Request {
  return request(`/api/articles/${SLUG}/comments?locale=zh-CN`, {
    method: "POST",
    body,
    headers: { host: "no-wave.test", ...headers },
  });
}

test("the thread is fetched from the documented upstream path, uncacheable", async () => {
  const stub = commentsUpstream({ data: [{ id: "c1", body: "值得一读。" }] });
  const response = await handleArticleCommentsRequest(listRequest(), { slug: SLUG }, {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls.length, 1);
  assert.equal(
    stub.calls[0]?.url,
    `${API_BASE}/${commentsRequestPath(SLUG, "zh-CN")}`,
    "the upstream path and page limit must be exactly one implementation",
  );
  assert.match(stub.calls[0]?.url ?? "", new RegExp(`limit=${COMMENT_PAGE_LIMIT}$`));
});

test("an unconfigured API is a 503 that never reaches the network", async () => {
  const stub = commentsUpstream();
  const response = await handleArticleCommentsRequest(listRequest(), { slug: SLUG }, {
    apiBaseUrl: undefined,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(stub.calls, []);
});

test("a malformed slug or locale is a local 400, not an upstream round trip", async () => {
  const stub = commentsUpstream();
  for (const slug of ["Not_A_Slug", "trailing-", "../etc/passwd", ""]) {
    const response = await handleArticleCommentsRequest(listRequest(), { slug }, {
      apiBaseUrl: API_BASE,
      fetchImpl: stub.fetchImpl,
    });
    assert.equal(response.status, 400, `${slug} must be rejected locally`);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "BAD_USER_INPUT");
  }
  // The locale is read from the query string by each route adapter (one line:
  // `new URL(request.url).searchParams.get("locale")`), so the handler is given
  // it explicitly rather than parsing the URL again.
  const badLocale = await handleArticleCommentsRequest(listRequest("klingon"), { slug: SLUG, locale: "klingon" }, {
    apiBaseUrl: API_BASE,
    fetchImpl: stub.fetchImpl,
  });
  assert.equal(badLocale.status, 400);
  assert.deepEqual(stub.calls, [], "no request may leave the app for an invalid slug or locale");
});

test("a comment is only accepted from our own origin", async () => {
  const allowed = commentsUpstream({ data: { id: "c2" } }, 201);
  const same = await handleArticleCommentsRequest(
    postRequest(JSON.stringify({ body: "好" })),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: allowed.fetchImpl },
  );
  assert.equal(same.status, 201);
  const forwarded = allowed.calls.at(0);
  assert.equal(forwarded?.init?.method, "POST");
  assert.equal(forwarded?.init?.body, JSON.stringify({ body: "好" }));

  const stub = commentsUpstream({ data: { id: "c2" } }, 201);
  const cross = await handleArticleCommentsRequest(
    postRequest(JSON.stringify({ body: "好" }), { origin: "https://evil.test" }),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(cross.status, 403);
  assert.equal((await cross.json() as { error: { code: string } }).error.code, "ORIGIN_REJECTED");

  // A cross-origin request must not learn whether the slug it guessed exists.
  const crossBadSlug = await handleArticleCommentsRequest(
    request("/api/articles/Not_A_Slug/comments", {
      method: "POST",
      body: JSON.stringify({ body: "好" }),
      headers: { origin: "https://evil.test", host: "no-wave.test" },
    }),
    { slug: "Not_A_Slug" },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(crossBadSlug.status, 403);
  assert.deepEqual(stub.calls, [], "nothing may be forwarded before the origin check passes");
});

test("the write is authorized by the HttpOnly cookie, not by the request body", async () => {
  const stub = stubFetch({
    "api/v1/articles/": (call) => {
      const headers = new Headers((call.init?.headers ?? {}) as HeadersInit);
      return json({ data: { authorization: headers.get("authorization") } }, 201);
    },
  });
  await handleArticleCommentsRequest(
    postRequest(JSON.stringify({ body: "好" }), { cookie: `${ACCESS_TOKEN_COOKIE}=access-token-value` }),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  const upstream = stub.calls[0];
  assert.ok(upstream);
  const headers = new Headers((upstream.init?.headers ?? {}) as HeadersInit);
  assert.equal(headers.get("authorization"), "Bearer access-token-value");
});

test("a comment body is bounded and must be JSON", async () => {
  const stub = commentsUpstream({ data: { id: "c3" } }, 201);

  const notJson = await handleArticleCommentsRequest(
    postRequest("body=text", { "content-type": "text/plain" }),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(notJson.status, 415);

  const tooLarge = await handleArticleCommentsRequest(
    postRequest(JSON.stringify({ body: "x".repeat(COMMENT_BODY_MAX_BYTES + 1) })),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(tooLarge.status, 413);

  const arrayBody = await handleArticleCommentsRequest(
    postRequest(JSON.stringify([1, 2, 3])),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(arrayBody.status, 400);
  assert.deepEqual(stub.calls, []);
});

test("only the thread's own methods are proxied", async () => {
  const stub = commentsUpstream();
  for (const method of ["DELETE", "PUT", "PATCH"]) {
    const response = await handleArticleCommentsRequest(
      new Request(`https://no-wave.test/api/articles/${SLUG}/comments`, {
        method,
        headers: { origin: "https://no-wave.test", host: "no-wave.test" },
      }),
      { slug: SLUG },
      { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
    );
    assert.equal(response.status, 405, `${method} must not be forwarded`);
  }
  assert.deepEqual(stub.calls, []);
});

test("an upstream failure keeps its status and its own error envelope", async () => {
  const clientError = stubFetch({
    "api/v1/articles/": () => json({ error: { code: "BAD_USER_INPUT", message: "Comment is empty." } }, 400),
  });
  const bad = await handleArticleCommentsRequest(
    postRequest(JSON.stringify({ body: "" })),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: clientError.fetchImpl },
  );
  assert.equal(bad.status, 400);
  assertNoStore(bad);
  assert.deepEqual(await bad.json(), { error: { code: "BAD_USER_INPUT", message: "Comment is empty." } });

  // Documented, not fixed: `forwardAuthoringRequest` relays the upstream body
  // verbatim, so a 5xx from the API reaches the browser with whatever detail the
  // API put in it. Sanitizing it belongs in the shared forwarder and would change
  // every proxied route at once — an owner decision, recorded in
  // docs/roadmap/public-ssr-migration.md, not a side effect of this slice.
  const serverError = stubFetch({
    "api/v1/articles/": () => json({ error: { code: "INTERNAL", message: "upstream exploded" } }, 500),
  });
  const broken = await handleArticleCommentsRequest(listRequest(), { slug: SLUG }, {
    apiBaseUrl: API_BASE,
    fetchImpl: serverError.fetchImpl,
  });
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: { code: "INTERNAL", message: "upstream exploded" } });
});

test("an unreachable API is a 502 that never leaks the failure detail", async () => {
  const response = await handleArticleCommentsRequest(listRequest(), { slug: SLUG }, {
    apiBaseUrl: API_BASE,
    fetchImpl: () => Promise.reject(new Error("ECONNREFUSED 10.0.0.4:4000")),
  });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /ECONNREFUSED|10\.0\.0\.4/);
});
