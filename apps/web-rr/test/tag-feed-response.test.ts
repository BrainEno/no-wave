import assert from "node:assert/strict";
import test from "node:test";
import { getArticleBySlug } from "../../../packages/web-ui/src/lib/content.ts";
import type { TagPageSource } from "../../../packages/web-ui/src/lib/tag-pages.ts";
import { handleTagFeedRequest, matchesFeedEtag } from "../app/lib/tag-feed-response.server.ts";

const fixtureArticle = getArticleBySlug("portable-web-foundation");
assert.ok(fixtureArticle);
const options = { slug: "public-theme", format: "atom", locale: "zh-CN" as const, siteUrl: "https://public.example" };
function fixture(overrides: Partial<TagPageSource> = {}) {
  const calls: string[] = [];
  const source: TagPageSource = {
    async listTags() { throw new Error("A subscription must not scan the directory."); },
    async getTag(slug, locale) { calls.push(`tag:${slug}:${locale}`); return { slug, name: "地方与记忆", description: "公开摘要", locale, articleCount: 1 }; },
    async listArticles(slug, locale, limit, offset) {
      calls.push(`works:${slug}:${locale}:${limit}:${offset}`);
      return [{ ...fixtureArticle!, locale }];
    },
    ...overrides,
  };
  const request = (headers: HeadersInit = {}, method = "GET", path = "/tags/public-theme/feed.atom") => new Request(`https://untrusted-request-host.example${path}`, { headers, method });
  return { source, calls, request };
}

test("GET produces an encoding-safe weak validator from the complete representation", async () => {
  const { source, calls, request } = fixture();
  const response = await handleTagFeedRequest(request(), options, source);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("etag") ?? "", /^W\/"[a-f0-9]{64}"$/);
  assert.match(response.headers.get("cache-control") ?? "", /public.*s-maxage=60/);
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
  assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, follow");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(response.headers.get("link") ?? "", /https:\/\/public.example\/tags\/public-theme\/feed.atom/);
  assert.ok(!body.includes("untrusted-request-host"));
  assert.deepEqual(calls, ["tag:public-theme:zh-CN", "works:public-theme:zh-CN:21:0"]);
});

test("matching validators return a bodyless 304 only after checking the current upstream page", async () => {
  const { source, calls, request } = fixture();
  const first = await handleTagFeedRequest(request(), options, source);
  const etag = first.headers.get("etag")!;
  const second = await handleTagFeedRequest(request({ "if-none-match": etag }), options, source);
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
  assert.equal(second.headers.get("etag"), etag);
  assert.equal(second.headers.get("cache-control"), first.headers.get("cache-control"));
  assert.equal(second.headers.get("content-type"), null);
  assert.equal(second.headers.get("content-length"), null);
  assert.equal(calls.length, 4, "no process-local stale response cache bypasses a removal");
});

test("If-None-Match uses weak GET comparison and parses complete lists, including commas inside quotes", () => {
  const etag = 'W/"current"';
  for (const value of ['"current"', 'W/"current"', '*', ' "older", W/"current" ', '"opaque,comma", "current"']) {
    assert.equal(matchesFeedEtag(value, etag), true, value);
  }
  for (const value of [null, "", '\n"current"', "\r*", '"other"', 'w/"current"', 'current', '"current",', '"current", broken', '*, "current"', '"unclosed, "current"', '"current" extra', "x".repeat(9000)]) {
    assert.equal(matchesFeedEtag(value, etag), false, String(value).slice(0, 50));
  }
});

test("a stale tag label or changed summary invalidates the same URL without trusting publication time", async () => {
  const base = fixture();
  const first = await handleTagFeedRequest(base.request(), options, base.source);
  const headers = { "if-none-match": first.headers.get("etag")! };
  const renamed = fixture({ getTag: async (slug, locale) => ({ slug, locale, name: "重命名", description: "", articleCount: 1 }) });
  const label = await handleTagFeedRequest(base.request(headers), options, renamed.source);
  assert.equal(label.status, 200);
  assert.notEqual(label.headers.get("etag"), first.headers.get("etag"));
  const edited = fixture({ listArticles: async () => [{ ...fixtureArticle!, description: "new summary" }] });
  const summary = await handleTagFeedRequest(base.request(headers), options, edited.source);
  assert.equal(summary.status, 200);
  assert.notEqual(summary.headers.get("etag"), first.headers.get("etag"));
  assert.equal(summary.headers.get("last-modified"), null, "the API does not expose a complete collection modification clock");
});

test("If-Modified-Since alone cannot hide metadata edits behind an invented last-modified clock", async () => {
  const { request, source } = fixture();
  const response = await handleTagFeedRequest(request({ "if-modified-since": "Wed, 01 Jan 2099 00:00:00 GMT" }), options, source);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("last-modified"), null);
  assert.match(await response.text(), /<feed /);
});

test("HEAD returns GET representation headers and no entity, including conditional HEAD", async () => {
  const { request, source } = fixture();
  const get = await handleTagFeedRequest(request(), options, source);
  const head = await handleTagFeedRequest(request({}, "HEAD"), options, source);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), get.headers.get("etag"));
  assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
  assert.equal(await head.text(), "");
  const conditional = await handleTagFeedRequest(request({ "if-none-match": get.headers.get("etag")! }, "HEAD"), options, source);
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
});

test("query aliases redirect to the one relative canonical feed URL before touching the API", async () => {
  const { request, source, calls } = fixture();
  const response = await handleTagFeedRequest(request({}, "GET", "/tags/public-theme/feed.atom?page=100&q=private"), options, source);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/tags/public-theme/feed.atom");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls, []);
});

test("unsupported methods and invalid identities do not consume a public read budget", async () => {
  const { request, source, calls } = fixture();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await handleTagFeedRequest(request({}, method), options, source);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  for (const invalid of [{ slug: "../other" }, { slug: undefined }, { format: "json" }, { format: undefined }]) {
    assert.equal((await handleTagFeedRequest(request(), { ...options, ...invalid }, source)).status, 404);
  }
  assert.deepEqual(calls, []);
});

test("missing and removed tags remain private 404s even with a wildcard condition", async () => {
  for (const removed of [false, true]) {
    const { request, source } = fixture({ getTag: async (slug, locale) => removed ? { slug, locale, name: "gone", description: "", articleCount: 1 } : null,
      listArticles: async () => null });
    const response = await handleTagFeedRequest(request({ "if-none-match": "*" }), options, source);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("etag"), null);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});

test("upstream identity, collection and renderer failures all produce safe uncacheable 503s", async () => {
  const privateDiagnostic = "synthetic-private-database-diagnostic";
  const sources = [
    fixture({ getTag: async () => { throw new Error(privateDiagnostic); } }).source,
    fixture({ listArticles: async () => { throw new Error(privateDiagnostic); } }).source,
    fixture({ listArticles: async () => [{ ...fixtureArticle!, publishedAt: privateDiagnostic }] }).source,
    fixture({ listArticles: async () => [{ ...fixtureArticle!, locale: "en" }] }).source,
  ];
  for (const source of sources) {
    const response = await handleTagFeedRequest(fixture().request({ "if-none-match": "*" }), options, source);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(response.headers.get("etag"), null);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(!(await response.text()).includes(privateDiagnostic));
  }
});

test("RSS and English variants cannot reuse another representation's validator", async () => {
  const { request, source } = fixture();
  const original = await handleTagFeedRequest(request(), options, source);
  const headers = { "if-none-match": original.headers.get("etag")! };
  const rss = await handleTagFeedRequest(request(headers), { ...options, format: "xml" }, source);
  const english = await handleTagFeedRequest(request(headers), { ...options, locale: "en" }, source);
  assert.equal(rss.status, 200);
  assert.equal(english.status, 200);
  assert.match(rss.headers.get("content-type") ?? "", /^application\/rss\+xml/);
  const englishFeedId = /<id>([^<]+)<\/id>/.exec(await english.text())?.[1];
  assert.equal(englishFeedId, "https://public.example/en/tags/public-theme");
  assert.notEqual(rss.headers.get("etag"), english.headers.get("etag"));
});

test("viewer cookies and bearer headers do not affect the anonymous representation", async () => {
  const { request, source } = fixture();
  const anonymous = await handleTagFeedRequest(request(), options, source);
  const viewer = await handleTagFeedRequest(request({ cookie: "nw_session=synthetic-marker", authorization: "Bearer synthetic-not-a-credential" }), options, source);
  assert.equal(viewer.headers.get("etag"), anonymous.headers.get("etag"));
  assert.equal(await viewer.text(), await anonymous.text());
  assert.equal(viewer.headers.get("set-cookie"), null);
});
