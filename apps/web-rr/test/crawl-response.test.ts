import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleCrawlRequest, type CrawlResponseOptions } from "../app/lib/crawl-response.server.ts";

const SITE = "https://publisher.example";
const resources = ["sitemap", "robots"] as const;
function fixture(overrides: Partial<CrawlResponseOptions> = {}) {
  const origins: string[] = [];
  const options: CrawlResponseOptions = {
    siteUrl: () => `${SITE}/ignored?internal=configuration#fragment`,
    async loadEntries(origin) {
      origins.push(origin);
      return [{ url: `${origin}/articles/public-work`, lastModified: new Date("2026-11-01T00:00:00.000Z") }];
    },
    ...overrides,
  };
  const request = (headers: HeadersInit = {}, method = "GET", query = "") => new Request(`https://untrusted-incoming.example/sitemap.xml${query}`, { method, headers });
  return { options, origins, request };
}

test("only the normalized configured site origin can identify either crawl resource", async () => {
  const { options, origins, request } = fixture();
  const response = await handleCrawlRequest(request({ host: "outside.example", "forwarded": "host=outside.example", "x-forwarded-host": "outside.example" }), "sitemap", options);
  assert.equal(response.status, 200);
  assert.deepEqual(origins, [SITE]);
  const body = await response.text();
  assert.equal(/<loc>([^<]+)<\/loc>/.exec(body)?.[1], `${SITE}/articles/public-work`);
  assert.equal(response.headers.get("etag"), `W/"${createHash("sha256").update(body).digest("hex")}"`);
  const robots = await handleCrawlRequest(request(), "robots", options);
  assert.equal(await robots.text(), `User-Agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  assert.deepEqual(origins, [SITE], "robots must not depend on catalog availability");
});

test("malformed validators do not turn a current document into an accidental 304", async () => {
  const { options, origins, request } = fixture();
  const initial = await handleCrawlRequest(request(), "sitemap", options);
  const etag = initial.headers.get("etag")!;
  for (const value of [`${etag},`, `${etag}, invalid`, `*, ${etag}`, `${etag} extra`]) {
    const response = await handleCrawlRequest(request({ "if-none-match": value }), "sitemap", options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), etag);
  }
  assert.equal(origins.length, 5);
});

test("If-Modified-Since is ignored without a complete public directory modification clock", async () => {
  for (const resource of resources) {
    const { options, request } = fixture();
    const response = await handleCrawlRequest(request({ "if-modified-since": "Wed, 01 Jan 2099 00:00:00 GMT" }), resource, options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("last-modified"), null);
  }
});

test("normalization, source and rendering failures are all safe non-cacheable 503s, including conditional HEAD", async () => {
  const diagnostic = "synthetic-private-diagnostic";
  const invalidOptions: Partial<CrawlResponseOptions>[] = [
    { siteUrl: () => "https://reader:synthetic-password@publisher.example" },
    { siteUrl: () => "javascript:active()" },
    { siteUrl: () => { throw new Error(diagnostic); } },
    { loadEntries: async () => { throw new Error(diagnostic); } },
    { loadEntries: async () => [{ url: `${SITE}/article`, lastModified: new Date("invalid") }] },
    { loadEntries: async () => [{ url: "https://other-publication.example/articles/work" }] },
  ];
  for (const overrides of invalidOptions) {
    const { options, request } = fixture(overrides);
    for (const method of ["GET", "HEAD"]) {
      const response = await handleCrawlRequest(request({ "if-none-match": "*" }, method), "sitemap", options);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "60");
      assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(response.headers.get("etag"), null);
      assert.equal(response.headers.get("last-modified"), null);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(await response.text(), method === "HEAD" ? "" : "Crawl resource temporarily unavailable.\n");
    }
  }
});

test("bad site configuration also fails robots before a wildcard can validate it", async () => {
  const { options, origins, request } = fixture({ siteUrl: () => "/not-an-absolute-origin" });
  const response = await handleCrawlRequest(request({ "if-none-match": "*" }), "robots", options);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(origins, []);
});

test("query redirects and unsafe methods are resolved without reading even broken configuration", async () => {
  let configurations = 0;
  const { options, origins, request } = fixture({ siteUrl: () => { configurations++; throw new Error("synthetic-private-diagnostic"); } });
  for (const resource of resources) {
    const redirect = await handleCrawlRequest(request({}, "HEAD", "?q=synthetic-marker"), resource, options);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), resource === "sitemap" ? "/sitemap.xml" : "/robots.txt");
    assert.equal(await redirect.text(), "");
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await handleCrawlRequest(request({}, method), resource, options);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
      assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
      assert.equal(response.headers.get("etag"), null);
      assert.equal(await response.text(), "Method not allowed.\n");
    }
  }
  assert.equal(configurations, 0);
  assert.deepEqual(origins, []);
});

test("the weak validator hashes the whole rendered identity rather than a count or newest publication", async () => {
  const base = fixture();
  const first = await handleCrawlRequest(base.request(), "sitemap", base.options);
  const etag = first.headers.get("etag")!;
  const changed = fixture({ loadEntries: async () => [{ url: `${SITE}/articles/different-work`, lastModified: new Date("2026-11-01T00:00:00.000Z") }] });
  const second = await handleCrawlRequest(changed.request({ "if-none-match": etag }), "sitemap", changed.options);
  assert.equal(second.status, 200);
  assert.notEqual(second.headers.get("etag"), etag);
  const otherOrigin = fixture({ siteUrl: () => "https://second-publisher.example", loadEntries: async (origin) => [{ url: `${origin}/articles/public-work` }] });
  const migrated = await handleCrawlRequest(otherOrigin.request({ "if-none-match": etag }), "sitemap", otherOrigin.options);
  assert.equal(migrated.status, 200);
  assert.notEqual(migrated.headers.get("etag"), etag);
});

test("public representation never varies by viewer cookies, bearer values or reader language preferences", async () => {
  for (const resource of resources) {
    const { options, request } = fixture();
    const anonymous = await handleCrawlRequest(request(), resource, options);
    const viewer = await handleCrawlRequest(request({ cookie: "nw_access=synthetic-marker", authorization: "Bearer synthetic-marker", "accept-language": "en" }), resource, options);
    assert.equal(viewer.status, 200);
    assert.equal(viewer.headers.get("etag"), anonymous.headers.get("etag"));
    assert.equal(viewer.headers.get("vary"), "Accept-Encoding");
    assert.equal(viewer.headers.get("set-cookie"), null);
    assert.equal(await viewer.text(), await anonymous.text());
  }
});
