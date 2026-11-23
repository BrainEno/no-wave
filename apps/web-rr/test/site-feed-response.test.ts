import assert from "node:assert/strict";
import test from "node:test";
import { getArticleBySlug, type ArticleView } from "../../../packages/web-ui/src/lib/content.ts";
import { handleSiteFeedRequest } from "../app/lib/site-feed-response.server.ts";

const fixtureArticle = getArticleBySlug("portable-web-foundation");
assert.ok(fixtureArticle);
const options = { format: "atom", locale: "zh-CN" as const, siteUrl: "https://public.example" };

function fixture(articles: ArticleView[] = [{ ...fixtureArticle!, locale: "zh-CN", workType: "poetry" }], fail = false) {
  const calls: string[] = [];
  const source = () => ({
    async listPublicArticles(query: { locale?: string; sort?: string; limit?: number } = {}) {
      calls.push(`${query.locale}:${query.sort}:${query.limit}`);
      if (fail) throw new Error("upstream said: secret-diagnostic");
      return articles;
    },
  });
  const request = (headers: HeadersInit = {}, method = "GET", path = "/articles/feed.atom") => new Request(`https://untrusted-request-host.example${path}`, { headers, method });
  return { source, calls, request };
}

test("the site feed is one bounded anonymous read of the newest works, rendered against the configured origin", async () => {
  const { source, calls, request } = fixture();
  const response = await handleSiteFeedRequest(request(), options, source);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/atom+xml; charset=utf-8");
  assert.match(response.headers.get("etag") ?? "", /^W\/"[a-f0-9]{64}"$/);
  assert.match(response.headers.get("cache-control") ?? "", /public.*s-maxage=60/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, follow");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(response.headers.get("link") ?? "", /<https:\/\/public\.example\/articles\/feed\.atom>; rel="self"/);
  assert.deepEqual(calls, ["zh-CN:latest:20"]);
  assert.match(body, /<title type="text">无浪潮：最新作品<\/title>/);
  assert.match(body, /<link rel="alternate" type="text\/html" href="https:\/\/public\.example\/articles"\/>/);
  assert.match(body, /<id>https:\/\/public\.example\/articles\/portable-web-foundation<\/id>/);
  // Each entry is filed under its genre (ADR 0054).
  assert.match(body, /<category term="诗歌"\/>/);
  assert.ok(!body.includes("untrusted-request-host"));
});

test("RSS and English share the contract with their own addresses", async () => {
  const english = [{ ...fixtureArticle!, locale: "en" as const, workType: "novel" as const }];
  const { source, request } = fixture(english);
  const response = await handleSiteFeedRequest(request({}, "GET", "/en/articles/feed.xml"), { ...options, format: "xml", locale: "en" }, source);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/rss+xml; charset=utf-8");
  assert.match(body, /<atom:link href="https:\/\/public\.example\/en\/articles\/feed\.xml" rel="self"/);
  assert.match(body, /<link>https:\/\/public\.example\/en\/articles\/portable-web-foundation<\/link>/);
  assert.match(body, /<category>Fiction<\/category>/);
  assert.match(body, /<language>en<\/language>/);
});

test("a matching validator is a bodyless 304; HEAD has headers and no body", async () => {
  const { source, request } = fixture();
  const first = await handleSiteFeedRequest(request(), options, source);
  const etag = first.headers.get("etag")!;
  const again = await handleSiteFeedRequest(request({ "if-none-match": etag }), options, source);
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  const head = await handleSiteFeedRequest(request({}, "HEAD"), options, source);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("etag"), etag);
});

test("query strings redirect to the one canonical feed without reading upstream", async () => {
  const { source, calls, request } = fixture();
  const response = await handleSiteFeedRequest(request({}, "GET", "/articles/feed.atom?page=2"), options, source);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/articles/feed.atom");
  assert.deepEqual(calls, []);
});

test("unknown formats, other methods and upstream failures never become a feed", async () => {
  const { source, calls, request } = fixture();
  const unknown = await handleSiteFeedRequest(request(), { ...options, format: undefined }, source);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get("cache-control") ?? "", /no-store|private/);
  const post = await handleSiteFeedRequest(request({}, "POST"), options, source);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.deepEqual(calls, []);

  const broken = fixture(undefined, true);
  const failed = await handleSiteFeedRequest(broken.request(), options, broken.source);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "60");
  assert.equal(await failed.text(), "Feed temporarily unavailable.\n");
  assert.match(failed.headers.get("cache-control") ?? "", /no-store|private/);

  // A work in another locale is an upstream inconsistency, not something to publish.
  const mixed = fixture([{ ...fixtureArticle!, locale: "en" }]);
  assert.equal((await handleSiteFeedRequest(mixed.request(), options, mixed.source)).status, 503);
});
