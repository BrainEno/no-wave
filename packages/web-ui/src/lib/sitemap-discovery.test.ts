import assert from "node:assert/strict";
import test from "node:test";
import { loadSitemapEntries, renderSitemapXml, SITEMAP_MAX_PAGES, SITEMAP_PAGE_SIZE } from "./site-metadata.ts";
import type { SitemapArticle, SitemapPageOptions, SitemapSource } from "./sitemap-catalog.ts";

const SITE = "https://crawl.example";
function article(index: number, locale: SitemapPageOptions["locale"]): SitemapArticle {
  return { slug: `work-${index}`, locale, publishedAt: "2026-10-01T00:00:00.000Z" };
}
function fixture(overrides: Partial<SitemapSource> = {}): SitemapSource {
  return { async listArticles() { return []; }, async listAuthors() { return []; }, async listCategories() { return []; }, async listTags() { return []; }, ...overrides };
}

test("empty catalogs still publish exactly the real public entry points, not account, search or feed URLs", async () => {
  const entries = await loadSitemapEntries({ siteUrl: SITE, source: fixture() });
  assert.deepEqual(entries.map(({ url }) => new URL(url).pathname).sort(), ["/", "/articles", "/authors", "/categories", "/tags", "/en", "/en/articles", "/en/authors", "/en/categories", "/en/tags"].sort());
  assert.ok(entries.every(({ url }) => new URL(url).search === "" && new URL(url).hash === ""));
  assert.ok(entries.every(({ lastModified }) => lastModified === undefined), "directory pages have no invented last-modified timestamp");
});

test("an author can be discovered with no article in the bounded work window", async () => {
  const source = fixture({ async listAuthors({ locale }) { return [{ username: "independent-writer", locale }]; } });
  const entries = await loadSitemapEntries({ siteUrl: SITE, source, maxPages: 1 });
  const urls = entries.map(({ url }) => url);
  assert.ok(urls.includes(`${SITE}/authors/independent-writer`));
  assert.ok(urls.includes(`${SITE}/en/authors/independent-writer`));
  assert.equal(entries.filter(({ url }) => /\/articles\//.test(url)).length, 0);
});

test("stored taxonomy identity is locale-specific, independent of names, counts and article-page references", async () => {
  const source = fixture({
    async listCategories({ locale }) { return [{ slug: locale === "en" ? "english-section" : "stored-section", locale }]; },
    async listTags({ locale }) { return [{ slug: locale === "en" ? "english-theme" : "stored-theme", locale }]; },
  });
  const entries = await loadSitemapEntries({ siteUrl: SITE, source });
  const paths = entries.map(({ url }) => new URL(url).pathname);
  for (const path of ["/categories/stored-section", "/en/categories/english-section", "/tags/stored-theme", "/en/tags/english-theme"]) assert.ok(paths.includes(path));
  assert.equal(paths.includes("/tags/english-theme"), false);
  assert.equal(paths.includes("/en/tags/stored-theme"), false);
});

test("all four scans advance by raw page size and stop independently on a short page", async () => {
  const calls: { collection: string; locale: string; offset: number; limit: number }[] = [];
  const list = (collection: string) => ({ locale, offset, limit }: SitemapPageOptions) => {
    calls.push({ collection, locale, offset, limit });
    return Array.from({ length: offset === 0 ? SITEMAP_PAGE_SIZE : 1 }, (_, index) => ({ ...article(offset + index, locale), username: `writer-${offset + index}` }));
  };
  const source = fixture(Object.fromEntries(["listArticles", "listAuthors", "listCategories", "listTags"].map((method) => [method, async (page: SitemapPageOptions) => list(method)(page)])));
  const entries = await loadSitemapEntries({ siteUrl: SITE, source });
  assert.equal(entries.length, 818);
  for (const locale of ["zh-CN", "en"]) {
    for (const collection of ["listArticles", "listAuthors", "listCategories", "listTags"]) {
      assert.deepEqual(calls.filter((call) => call.locale === locale && call.collection === collection).map(({ offset, limit }) => ({ offset, limit })), [{ offset: 0, limit: 100 }, { offset: 100, limit: 100 }]);
    }
  }
});

test("a configured ceiling bounds every scan, including a full final page without a sentinel probe", async () => {
  const offsets: number[] = [];
  const list = async ({ locale, offset }: SitemapPageOptions) => {
    offsets.push(offset);
    return Array.from({ length: 100 }, (_, index) => ({ ...article(offset + index, locale), username: `writer-${offset + index}` }));
  };
  const entries = await loadSitemapEntries({ siteUrl: SITE, maxPages: 2, source: { listArticles: list, listAuthors: list, listCategories: list, listTags: list } });
  assert.equal(entries.length, 1610);
  assert.equal(offsets.length, 16);
  assert.ok(offsets.every((offset) => offset === 0 || offset === 100));
});

test("the default ceiling cannot silently become an unbounded historical scan", async () => {
  const offsets: number[] = [];
  const source = fixture({ async listArticles({ locale, offset }) {
    offsets.push(offset);
    return Array.from({ length: 100 }, (_, index) => article(offset + index, locale));
  } });
  const entries = await loadSitemapEntries({ siteUrl: SITE, source });
  assert.equal(offsets.length, 2 * SITEMAP_MAX_PAGES);
  assert.equal(Math.max(...offsets), 4900);
  assert.equal(entries.length, 10010);
});

test("invalid caller budgets fail before performing any discovery", async () => {
  let calls = 0;
  const source = fixture({ async listArticles() { calls++; return []; } });
  for (const maxPages of [0, -1, 1.5, 51, Infinity, NaN]) await assert.rejects(loadSitemapEntries({ siteUrl: SITE, source, maxPages }), /limit/i);
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, 120001]) await assert.rejects(loadSitemapEntries({ siteUrl: SITE, source, timeoutMs }));
  assert.equal(calls, 0);
});

test("overlapping offset pages de-duplicate URLs but keep the newest actual modification clock", async () => {
  const offsets: number[] = [];
  const source = fixture({ async listArticles({ locale, offset }) {
    offsets.push(offset);
    if (offset === 0) return Array.from({ length: 100 }, (_, index) => article(index, locale));
    return [{ ...article(99, locale), updatedAt: "2026-11-01T08:00:00+08:00" }, article(100, locale)];
  } });
  const entries = await loadSitemapEntries({ siteUrl: SITE, source });
  assert.deepEqual(offsets, [0, 100, 0, 100]);
  assert.equal(entries.length, 212);
  const updated = entries.find(({ url }) => url === `${SITE}/articles/work-99`);
  assert.equal(updated?.lastModified?.toISOString(), "2026-11-01T00:00:00.000Z");
});

test("duplicate rows inside a page and full pages without progress fail rather than waste the whole budget", async () => {
  const duplicate = fixture({ async listArticles({ locale }) { return [article(1, locale), article(1, locale)]; } });
  await assert.rejects(loadSitemapEntries({ siteUrl: SITE, source: duplicate }), /duplicate/i);
  let calls = 0;
  const repeated = fixture({ async listArticles({ locale }) { calls++; return Array.from({ length: 100 }, (_, index) => article(index, locale)); } });
  await assert.rejects(loadSitemapEntries({ siteUrl: SITE, source: repeated }), /progress/i);
  assert.equal(calls, 2);
});

test("same crawl facts in different upstream rank order yield byte-identical XML", async () => {
  const ordered = (reverse: boolean) => fixture({
    async listArticles({ locale }) { const rows = [article(1, locale), article(2, locale)]; return reverse ? rows.reverse() : rows; },
    async listAuthors({ locale }) { const rows = [{ username: "first", locale }, { username: "second", locale }]; return reverse ? rows.reverse() : rows; },
  });
  const first = renderSitemapXml(await loadSitemapEntries({ siteUrl: SITE, source: ordered(false) }));
  const second = renderSitemapXml(await loadSitemapEntries({ siteUrl: SITE, source: ordered(true) }));
  assert.equal(first, second);
});

test("opaque author identifiers are safely encoded into a single path segment without changing the configured origin", async () => {
  const username = "writer/one?query#fragment";
  const entries = await loadSitemapEntries({ siteUrl: `${SITE}/ignored`, source: fixture({ async listAuthors({ locale }) { return [{ username, locale }]; } }) });
  const urls = entries.filter(({ url }) => /\/authors\//.test(url)).map(({ url }) => new URL(url));
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.origin === SITE && url.search === "" && url.hash === ""));
  assert.equal(urls.find((url) => !url.pathname.startsWith("/en/"))?.pathname, `/authors/${encodeURIComponent(username)}`);
});

test("a pre-epoch publication does not acquire a fabricated 1970 modification date", async () => {
  const source = fixture({ async listArticles({ locale }) { return [{ ...article(1, locale), publishedAt: "1960-01-01T00:00:00Z", updatedAt: "1950-01-01T00:00:00Z" }]; } });
  const entries = await loadSitemapEntries({ siteUrl: SITE, source });
  assert.ok(entries.filter(({ lastModified }) => lastModified).every(({ lastModified }) => lastModified!.toISOString() === "1960-01-01T00:00:00.000Z"));
});

test("malformed injected pages and cross-locale identities cannot bypass the builder's validation boundary", async () => {
  const bad = [
    fixture({ async listArticles() { return null as unknown as SitemapArticle[]; } }),
    fixture({ async listArticles({ locale }) { return Array.from({ length: 101 }, (_, index) => article(index, locale)); } }),
    fixture({ async listArticles() { return [article(1, "en")]; } }),
    fixture({ async listAuthors({ locale }) { return [{ username: "..", locale }]; } }),
    fixture({ async listTags({ locale }) { return [{ slug: "../private", locale }]; } }),
    fixture({ async listCategories() { return [{ slug: "valid", locale: "en" }]; } }),
  ];
  for (const source of bad) await assert.rejects(loadSitemapEntries({ siteUrl: SITE, source }));
});

test("the whole scan times out once, propagates cancellation, and never starts another page after a late lister settles", { timeout: 1500 }, async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  let complete: ((rows: SitemapArticle[]) => void) | undefined;
  const source = fixture({ async listArticles(options) {
    calls++;
    signal = options.signal;
    return new Promise<SitemapArticle[]>((resolve) => { complete = resolve; });
  } });
  const started = performance.now();
  await assert.rejects(loadSitemapEntries({ siteUrl: SITE, source, timeoutMs: 20 }), /timeout|deadline|exceeded/i);
  assert.ok(performance.now() - started < 1000);
  assert.equal(signal?.aborted, true);
  complete!(Array.from({ length: 100 }, (_, index) => article(index, "zh-CN")));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
