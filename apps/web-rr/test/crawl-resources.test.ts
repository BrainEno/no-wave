import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CRAWL_PRIVATE_DIAGNOSTIC, startCrawlApi, type CrawlCollection } from "../mocks/crawl-api.ts";
import { startProductionWeb } from "./support/production-web.ts";

const SITE = "https://publication.example";
const resources = ["/sitemap.xml", "/robots.txt"] as const;
let api: Awaited<ReturnType<typeof startCrawlApi>>;
let app: Awaited<ReturnType<typeof startProductionWeb>>;
before(async () => {
  api = await startCrawlApi();
  app = await startProductionWeb({ API_BASE_URL: api.origin, API_TIMEOUT_MS: "400", SITE_URL: `${SITE}/ignored?internal=value#fragment` });
});
after(async () => { await app?.close(); await api?.close(); });

async function get(path: string, init: RequestInit = {}) {
  const response = await fetch(`${app.origin}${path}`, { redirect: "manual", ...init,
    headers: { "accept-encoding": "identity", ...init.headers } });
  return { status: response.status, headers: response.headers, body: await response.text() };
}
function locations(body: string) { return [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!); }
function safeUnavailable(response: Awaited<ReturnType<typeof get>>) {
  assert.equal(response.status, 503);
  assert.equal(response.body, "Crawl resource temporarily unavailable.\n");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(response.body.includes(CRAWL_PRIVATE_DIAGNOSTIC), false);
}

test("production sitemap discovers both locale taxonomies and authors independently of the article window", async () => {
  api.resetRequests();
  const response = await get("/sitemap.xml");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/xml; charset=utf-8");
  const urls = locations(response.body);
  assert.equal(urls.length, 818, "ten directories and 101 items in four collections in each locale");
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.every((value) => new URL(value).origin === SITE));
  for (const prefix of ["", "/en"]) {
    for (const path of ["/authors", "/categories", "/tags", "/articles", "/authors/older-writer-outside-article-window", "/categories/section-100", "/tags/theme-100"]) {
      assert.ok(urls.includes(`${SITE}${prefix}${path}`), `missing localized public path ${prefix}${path}`);
    }
  }
  assert.equal(response.body.includes(CRAWL_PRIVATE_DIAGNOSTIC), false);
  const calls = api.requests();
  assert.equal(calls.length, 16);
  for (const collection of ["articles", "authors", "categories", "tags"]) {
    for (const locale of ["zh-CN", "en"]) {
      assert.deepEqual(calls.filter(({ path, query }) => path === `/api/v1/${collection}` && query.locale === locale).map(({ query }) => query.offset), ["0", "100"]);
    }
  }
  assert.ok(calls.every(({ query }) => query.limit === "100" && !query.query));
});

test("GET and HEAD have identical entity metadata, and conditional requests re-read the current catalog", async () => {
  for (const path of resources) {
    const initial = await get(path);
    assert.equal(initial.status, 200);
    const etag = initial.headers.get("etag")!;
    assert.match(etag, /^W\/"[a-f0-9]{64}"$/);
    assert.equal(initial.headers.get("content-length"), String(Buffer.byteLength(initial.body)));
    assert.equal(initial.headers.get("vary"), "Accept-Encoding");
    assert.equal(initial.headers.get("x-content-type-options"), "nosniff");
    const head = await get(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    for (const name of ["etag", "content-type", "content-length", "cache-control", "vary"]) assert.equal(head.headers.get(name), initial.headers.get(name));
    api.resetRequests();
    const fresh = await get(path, { headers: { "if-none-match": `"older", ${etag.replace(/^W\//, "")}` } });
    assert.equal(fresh.status, 304);
    assert.equal(fresh.body, "");
    assert.equal(fresh.headers.get("etag"), etag);
    assert.equal(fresh.headers.get("content-type"), null);
    assert.equal(fresh.headers.get("content-length"), null);
    assert.equal(fresh.headers.get("cache-control"), initial.headers.get("cache-control"));
    assert.equal(api.requests().length, path === "/sitemap.xml" ? 16 : 0);
    const conditionalHead = await get(path, { method: "HEAD", headers: { "if-none-match": "*" } });
    assert.equal(conditionalHead.status, 304);
    assert.equal(conditionalHead.body, "");
  }
});

test("publication edits and removals invalidate the validator without an invented collection last-modified clock", async () => {
  const initial = await get("/sitemap.xml");
  const headers = { "if-none-match": initial.headers.get("etag")! };
  try {
    api.updateArticles({ version: 2 });
    const edited = await get("/sitemap.xml", { headers });
    assert.equal(edited.status, 200);
    assert.match(edited.body, /<lastmod>2026-11-02T00:00:00.000Z<\/lastmod>/);
    assert.notEqual(edited.headers.get("etag"), headers["if-none-match"]);
    assert.equal(edited.headers.get("last-modified"), null);
    api.updateArticles({ version: 2, removeLast: true });
    const removed = await get("/sitemap.xml", { headers: { "if-none-match": edited.headers.get("etag")! } });
    assert.equal(removed.status, 200);
    assert.equal(locations(removed.body).length, 816);
    assert.equal(locations(removed.body).includes(`${SITE}/articles/work-100`), false);
    assert.notEqual(removed.headers.get("etag"), edited.headers.get("etag"));
  } finally { api.updateArticles({ version: 1 }); }
});

test("query variants redirect to a fixed relative identity before spending any upstream work", async () => {
  for (const path of resources) {
    api.resetRequests();
    const response = await get(`${path}?page=2&q=synthetic-private-marker&host=outside.example`);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), path);
    assert.equal(response.body, "");
    assert.equal(response.headers.get("etag"), null);
    assert.deepEqual(api.requests(), []);
  }
});

test("resource actions refuse unsafe methods explicitly, without catalog scans or viewer state", async () => {
  for (const path of resources) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      api.resetRequests();
      const response = await get(path, { method, body: "synthetic-payload" });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
      assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.body, "Method not allowed.\n");
      assert.deepEqual(api.requests(), []);
    }
  }
});

for (const collection of ["articles", "authors", "categories", "tags"] satisfies CrawlCollection[]) {
  test(`an unavailable second ${collection} page cannot publish a partial sitemap or validate a wildcard`, async () => {
    api.setFault({ collection, offset: 100, mode: "unavailable" });
    try { safeUnavailable(await get("/sitemap.xml", { headers: { "if-none-match": "*" } })); }
    finally { api.setFault(); }
  });
}

test("malformed successful envelopes and invalid rows stay uncacheable through the production adapter", async () => {
  for (const collection of ["articles", "authors", "categories", "tags"] satisfies CrawlCollection[]) {
    for (const mode of ["malformed", "invalid-row"] as const) {
      api.setFault({ collection, locale: "en", mode });
      try { safeUnavailable(await get("/sitemap.xml")); }
      finally { api.setFault(); }
    }
  }
});

test("a stalled API fails within its deadline, while robots still works without the API", { timeout: 5000 }, async () => {
  api.setFault({ collection: "articles", mode: "stall" });
  try {
    const started = performance.now();
    safeUnavailable(await get("/sitemap.xml"));
    assert.ok(performance.now() - started < 3000);
    api.resetRequests();
    const robots = await get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.equal(robots.body, `User-Agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
    assert.deepEqual(api.requests(), []);
  } finally { api.setFault(); }
});

test("cookies, bearer values and conditional headers are never forwarded to the public catalog", async () => {
  api.resetRequests();
  const response = await get("/sitemap.xml", { headers: { cookie: "nw_access=synthetic-marker; nw_refresh=synthetic-marker", authorization: "Bearer synthetic-not-a-secret", "if-none-match": "*", "if-modified-since": "Wed, 01 Jan 2099 00:00:00 GMT" } });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(api.requests().length, 16);
  assert.ok(api.requests().every(({ hasCredentials, hasCondition }) => !hasCredentials && !hasCondition));
});

test("a malformed configured origin is an uncacheable production 503, never a credential-bearing robots or sitemap URL", async () => {
  const broken = await startProductionWeb({ API_BASE_URL: api.origin, SITE_URL: "https://reader:synthetic-password@publication.example" });
  try {
    api.resetRequests();
    for (const path of resources) {
      const response = await fetch(`${broken.origin}${path}`, { headers: { "if-none-match": "*" } });
      safeUnavailable({ status: response.status, headers: response.headers, body: await response.text() });
      const head = await fetch(`${broken.origin}${path}`, { method: "HEAD" });
      assert.equal(head.status, 503);
      assert.equal(head.headers.get("cache-control"), "no-store, max-age=0");
      assert.equal(head.headers.get("etag"), null);
      assert.equal(await head.text(), "");
    }
    assert.deepEqual(api.requests(), []);
  } finally { await broken.close(); }
});

test("encoding preferences preserve crawl validators without broadening the origin compression allowlist", async () => {
  const initial = await get("/sitemap.xml");
  const compressed = await get("/sitemap.xml", { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressed.status, 200);
  // Origin compression deliberately remains limited to public HTML and JS/CSS.
  assert.equal(compressed.headers.get("content-encoding"), null);
  assert.equal(compressed.headers.get("content-length"), initial.headers.get("content-length"));
  assert.equal(compressed.headers.get("etag"), initial.headers.get("etag"));
  assert.equal(compressed.body, initial.body);
  const fresh = await get("/sitemap.xml", { headers: { "accept-encoding": "gzip", "if-none-match": initial.headers.get("etag")! } });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.body, "");
  assert.equal(fresh.headers.get("content-length"), null);
});
