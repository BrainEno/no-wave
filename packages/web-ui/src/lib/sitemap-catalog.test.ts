import assert from "node:assert/strict";
import test from "node:test";
import { createApiSitemapSource, createFixtureSitemapSource, SITEMAP_API_BODY_LIMIT, type SitemapPageOptions } from "./sitemap-catalog.ts";

const page: SitemapPageOptions = { locale: "zh-CN", limit: 100, offset: 0 };
const published = { title: "Public work", author: { userId: "writer", displayName: "Writer" }, slug: "public-work", status: "published", locale: "zh-CN", publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
const writer = { userId: "writer", displayName: "作者", locale: "zh-TW", followerCount: 0, workCount: 1 };
const taxonomy = { slug: "persisted-topic", name: "主题", locale: "zh-CN", articleCount: 0 };
const methods = ["listArticles", "listAuthors", "listCategories", "listTags"] as const;
function json(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } }); }
function fixture(payload: unknown, status = 200) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const source = createApiSitemapSource({ endpoint: "https://api.example/prefix", timeoutMs: 40, fetchImpl: async (input, init) => {
    requests.push({ url: new URL(input), init });
    return json(payload, status);
  } });
  return { source, requests };
}

test("the crawl client projects only identity and real publication clocks, not full reader documents", async () => {
  const input = { ...published, author: { ...published.author, email: "synthetic@example.test" }, contentBlocks: "not parsed by a crawl projection", summary: "synthetic-private-marker" };
  const { source } = fixture({ data: [input] });
  assert.deepEqual(await source.listArticles(page), [{ slug: published.slug, locale: page.locale, publishedAt: published.publishedAt, updatedAt: published.updatedAt }]);
  const directory = fixture({ data: [{ ...taxonomy, createdBy: "synthetic-private-marker" }] });
  assert.deepEqual(await directory.source.listTags(page), [{ slug: taxonomy.slug, locale: page.locale }]);
  assert.deepEqual(await directory.source.listCategories(page), [{ slug: taxonomy.slug, locale: page.locale }]);
});

test("author discovery accepts the API's documented profile-translation fallback, not a fabricated work locale", async () => {
  const { source } = fixture({ data: [writer] });
  assert.deepEqual(await source.listAuthors(page), [{ username: "writer", locale: "zh-CN" }]);
  assert.deepEqual(await source.listAuthors({ ...page, locale: "en" }), [{ username: "writer", locale: "en" }]);
});

test("all collections have fixed anonymous GET transport and preserve an explicitly configured API prefix", async () => {
  for (const method of methods) {
    const row = method === "listArticles" ? published : method === "listAuthors" ? writer : taxonomy;
    const { source, requests } = fixture({ data: [row] });
    await source[method]({ ...page, offset: 100 });
    assert.equal(requests.length, 1);
    const { url, init } = requests[0]!;
    assert.equal(url.origin, "https://api.example");
    assert.equal(url.pathname, `/prefix/api/v1/${method.slice(4).toLowerCase()}`);
    assert.deepEqual(Object.fromEntries(url.searchParams), { locale: "zh-CN", limit: "100", offset: "100", ...(method === "listArticles" ? { sort: "latest" } : {}) });
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { accept: "application/json" });
    assert.ok(init?.signal instanceof AbortSignal);
  }
});

test("missing, non-array and error envelopes never become a successful empty directory", async () => {
  for (const payload of [null, [], {}, { data: null }, { data: {} }, { data: "[]" }, { data: [], error: { code: "INTERNAL" } }, { data: [], error: "unavailable" }]) {
    for (const method of methods) await assert.rejects(fixture(payload).source[method](page), /sitemap|catalog/i);
  }
  for (const method of methods) assert.deepEqual(await fixture({ data: [] }).source[method](page), []);
});

test("HTTP absence, authentication failures and unavailable dependencies are not empty catalogs", async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 503]) {
    for (const method of methods) await assert.rejects(fixture({ error: { message: "synthetic-private-marker" } }, status).source[method](page), /sitemap|catalog/i);
  }
});

test("publication visibility and locale cannot be guessed by a tolerant public-page mapper", async () => {
  for (const patch of [{ status: "draft" }, { status: "deleted" }, { status: undefined }, { locale: "en" }, { locale: undefined }, { deletedAt: "2026-11-01T00:00:00.000Z" }]) {
    await assert.rejects(fixture({ data: [{ ...published, ...patch }] }).source.listArticles(page), /sitemap|catalog/i);
  }
  for (const value of [null, 1, [], {}, { ...published, slug: "../../private" }, { ...published, slug: "" }, { ...published, slug: "bad_slug" }, { ...published, slug: "a".repeat(161) }]) {
    await assert.rejects(fixture({ data: [value] }).source.listArticles(page), /sitemap|catalog/i);
  }
});

test("works missing the reader's required title or public byline are errors, not silently filtered short pages", async () => {
  for (const patch of [{ title: "" }, { title: undefined }, { author: null }, { author: {} },
    { author: { ...published.author, userId: ".." } }, { author: { ...published.author, displayName: " " } }]) {
    await assert.rejects(fixture({ data: [published, { ...published, ...patch }] }).source.listArticles(page), /sitemap|catalog/i);
  }
});

test("missing publication time, calendar rollover and bad modification metadata fail instead of falling back to createdAt", async () => {
  for (const clock of [undefined, null, "", "yesterday", "2026-02-30T00:00:00Z", "2026-10-01", 1]) {
    await assert.rejects(fixture({ data: [{ ...published, publishedAt: clock, createdAt: published.publishedAt }] }).source.listArticles(page), /timestamp|sitemap|catalog/i);
  }
  for (const updatedAt of [1, {}, "bad-clock", "2026-04-31T00:00:00Z"]) {
    await assert.rejects(fixture({ data: [{ ...published, updatedAt }] }).source.listArticles(page), /timestamp|sitemap|catalog/i);
  }
  const older = { ...published, publishedAt: "1960-01-01T08:00:00+08:00", updatedAt: null };
  assert.deepEqual(await fixture({ data: [older] }).source.listArticles(page), [{ slug: older.slug, locale: page.locale, publishedAt: "1960-01-01T00:00:00.000Z" }]);
});

test("a bad author cannot silently shorten a page or enumerate accounts without published work", async () => {
  for (const row of [null, {}, { ...writer, userId: "" }, { ...writer, userId: ".." }, { ...writer, userId: "writer\n" }, { ...writer, userId: "x".repeat(301) },
    { ...writer, userId: "\ud800" }, { ...writer, displayName: " " }, { ...writer, locale: "fr" }, { ...writer, followerCount: -1 }, { ...writer, workCount: 0 }, { ...writer, workCount: 1.5 }]) {
    await assert.rejects(fixture({ data: [writer, row] }).source.listAuthors(page), /sitemap|catalog/i);
  }
  const opaque = "writer/with spaces?and#delimiters";
  assert.deepEqual(await fixture({ data: [{ ...writer, userId: opaque }] }).source.listAuthors(page), [{ username: opaque, locale: page.locale }]);
});

test("taxonomy identity, requested locale and non-negative counts are required even on empty detail pages", async () => {
  for (const method of ["listCategories", "listTags"] as const) {
    for (const row of [null, {}, { ...taxonomy, slug: "javascript:active()" }, { ...taxonomy, slug: "a--b" }, { ...taxonomy, name: "" },
      { ...taxonomy, locale: "en" }, { ...taxonomy, locale: undefined }, { ...taxonomy, articleCount: -1 }, { ...taxonomy, articleCount: "0" }, { ...taxonomy, articleCount: 1.5 }]) {
      await assert.rejects(fixture({ data: [taxonomy, row] }).source[method](page), /sitemap|catalog/i);
    }
  }
});

test("a response larger than the requested row limit fails instead of expanding a crawler's scan budget", async () => {
  for (const method of methods) {
    const row = method === "listArticles" ? published : method === "listAuthors" ? writer : taxonomy;
    await assert.rejects(fixture({ data: Array.from({ length: 101 }, () => row) }).source[method](page), /limit|sitemap|catalog/i);
  }
});

test("invalid scan arguments and an already cancelled request fail before opening a socket", async () => {
  const { source, requests } = fixture({ data: [] });
  const invalid = [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 5000 }, { offset: Infinity }, { offset: 0.5 }, { locale: "zh-TW" }];
  for (const patch of invalid) {
    for (const method of methods) await assert.rejects(source[method]({ ...page, ...patch } as SitemapPageOptions));
  }
  const signal = AbortSignal.abort();
  await assert.rejects(source.listArticles({ ...page, signal }));
  assert.deepEqual(requests, []);
});

test("invalid endpoints and deadline configuration are rejected at construction without network access", () => {
  for (const endpoint of ["", "relative", "file:///tmp/api", "https://name:password@api.example"]) assert.throws(() => createApiSitemapSource({ endpoint }));
  for (const timeoutMs of [0, -1, 1.5, NaN, 120001, "not-an-integer"]) assert.throws(() => createApiSitemapSource({ endpoint: "https://api.example", timeoutMs }));
});

for (const phase of ["connection", "body"] as const) {
  test(`a non-cooperating ${phase} cannot outlive the per-call catalog deadline`, { timeout: 1500 }, async () => {
    let signal: AbortSignal | null | undefined;
    let cancelled = false;
    const source = createApiSitemapSource({ endpoint: "https://api.example", timeoutMs: 20, fetchImpl: async (_input, init) => {
      signal = init?.signal;
      if (phase === "connection") return new Promise<never>(() => {});
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    } });
    const started = performance.now();
    await assert.rejects(source.listArticles(page), /timeout|deadline|exceeded/i);
    assert.ok(performance.now() - started < 1000);
    assert.equal(signal?.aborted, true);
    if (phase === "body") assert.equal(cancelled, true);
  });
}

test("the catalog bounds decompressed body bytes even when the response lies about content-length", async () => {
  let cancelled = false;
  const source = createApiSitemapSource({ endpoint: "https://api.example", fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json", "content-length": "1" } }) });
  assert.ok(SITEMAP_API_BODY_LIMIT > 0 && SITEMAP_API_BODY_LIMIT <= 8 * 1024 * 1024);
  await assert.rejects(source.listArticles(page), /limit|sitemap|catalog/i);
  assert.equal(cancelled, true);
});

test("oversized declared bodies, malformed JSON, invalid UTF-8 and wrong media types are not empty successes", async () => {
  const responses = [
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(SITEMAP_API_BODY_LIMIT + 1) } }),
    () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { headers: { "content-type": "application/json" } }),
    () => new Response('{"data":[]}', { headers: { "content-type": "text/html" } }),
  ];
  for (const response of responses) {
    const source = createApiSitemapSource({ endpoint: "https://api.example", fetchImpl: async () => response() });
    await assert.rejects(source.listArticles(page));
  }
});

test("the explicit offline fixture source lists fixture authors but never invents taxonomies or uses environment APIs", async () => {
  const source = createFixtureSitemapSource();
  const articles = await source.listArticles(page);
  assert.ok(articles.length > 0);
  assert.ok(articles.every((article) => article.locale === page.locale));
  assert.deepEqual(await source.listAuthors(page), [{ username: "bot-thk-team", locale: page.locale }]);
  assert.deepEqual(await source.listAuthors({ ...page, offset: 100 }), []);
  assert.deepEqual(await source.listTags(page), []);
  assert.deepEqual(await source.listCategories(page), []);
});
