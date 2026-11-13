import assert from "node:assert/strict";
import test from "node:test";
import { createApiContentClient } from "../../../packages/web-ui/src/lib/api-content.ts";
import type { TagPageSource } from "../../../packages/web-ui/src/lib/tag-pages.ts";
import { handleTagFeedRequest } from "../app/lib/tag-feed-response.server.ts";

const tag = { slug: "public-tag", name: "回忆", description: "公开标签", articleCount: 1, locale: "zh-CN" };
const article = { slug: "public-article", title: "公开作品", summary: "摘要", status: "published", locale: "zh-CN", publishedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z", author: { userId: "author", displayName: "作者" }, contentBlocks: [], tags: [tag], categories: [] };
const options = { slug: tag.slug, format: "atom", locale: "zh-CN" as const, siteUrl: "https://reader.example" };
const request = () => new Request("https://incoming.example/tags/public-tag/feed.atom", {
  headers: { cookie: "nw_session=synthetic-marker", authorization: "Bearer synthetic-not-a-secret", "if-none-match": "*" },
});
type Scenario = { identity?: unknown; articles?: unknown; identityStatus?: number; articleStatus?: number; stalledBody?: boolean; stalledFetch?: boolean };
function fixture(scenario: Scenario = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = createApiContentClient({ endpoint: "https://independent-api.example/prefix", timeoutMs: 25, fetchImpl: async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const collection = url.pathname.endsWith("/articles");
    if (collection && scenario.stalledFetch) return new Promise<never>(() => {});
    const status = collection ? scenario.articleStatus ?? 200 : scenario.identityStatus ?? 200;
    return { status, ok: status >= 200 && status < 300, async json() {
      if (collection && scenario.stalledBody) return new Promise<never>(() => {});
      return { data: collection ? scenario.articles ?? [article] : scenario.identity ?? tag };
    } };
  } });
  const source: TagPageSource = { listTags: client.listTags, getTag: client.getTagBySlug, listArticles: client.listTagArticles };
  return { source, calls };
}

test("the composed subscription never forwards viewer credentials or conditional headers upstream", async () => {
  const { source, calls } = fixture();
  const response = await handleTagFeedRequest(request(), options, source);
  assert.equal(response.status, 304, "wildcard applies only after current public data is available");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url }) => url.pathname), ["/prefix/api/v1/tags/public-tag", "/prefix/api/v1/tags/public-tag/articles"]);
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { locale: "zh-CN", limit: "21", offset: "0" });
  for (const { init } of calls) {
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(init?.headers, { accept: "application/json" });
    assert.ok(init?.signal instanceof AbortSignal);
  }
});

test("the API host and path prefix are not accidentally published as subscriber permalinks", async () => {
  const { source } = fixture();
  const response = await handleTagFeedRequest(new Request("https://incoming.example/tags/public-tag/feed.atom"), options, source);
  const body = await response.text();
  assert.equal(response.status, 200);
  const articleId = /<entry>\s*<id>([^<]+)<\/id>/.exec(body)?.[1];
  assert.equal(articleId, "https://reader.example/articles/public-article");
  assert.ok(!body.includes("independent-api.example"));
  assert.ok(!body.includes("incoming.example"));
  assert.ok(!body.includes("/prefix/"));
});

test("identity 404 stops before a collection request and before wildcard validation", async () => {
  const { source, calls } = fixture({ identityStatus: 404 });
  const response = await handleTagFeedRequest(request(), options, source);
  assert.equal(response.status, 404);
  assert.equal(calls.length, 1);
  assert.equal(response.headers.get("etag"), null);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("a real HTTP 404 on the second read means removal, not an empty success or 304", async () => {
  const { source, calls } = fixture({ articleStatus: 404 });
  const response = await handleTagFeedRequest(request(), options, source);
  assert.equal(response.status, 404);
  assert.equal(calls.length, 2);
  assert.ok(!(await response.text()).includes("<feed"));
});

test("successful contract violations remain 503 through both mapper and response layers", async () => {
  const scenarios: Scenario[] = [
    { identity: { ...tag, locale: "en" } }, { identity: { ...tag, articleCount: -1 } },
    { articles: [{ ...article, status: "draft" }] }, { articles: [{ ...article, locale: "en" }] },
    { articles: [{ ...article, publishedAt: "invalid-publication-clock" }] },
    { articles: [{ ...article, updatedAt: "invalid-modification-clock" }] }, { articles: [article, article] },
  ];
  for (const scenario of scenarios) {
    const { source } = fixture(scenario);
    const response = await handleTagFeedRequest(request(), options, source);
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(await response.text(), "Tag feed temporarily unavailable.\n");
  }
});

test("API failures cannot be mistaken for absent tags or copied into public response diagnostics", async () => {
  for (const scenario of [{ identityStatus: 401 }, { identityStatus: 503 }, { articleStatus: 500 }]) {
    const { source } = fixture(scenario);
    const response = await handleTagFeedRequest(request(), options, source);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), "Tag feed temporarily unavailable.\n");
  }
});

for (const phase of ["fetch", "body"] as const) {
  test(`a stalled API ${phase} still meets the source deadline during conditional revalidation`, { timeout: 1500 }, async () => {
    const { source, calls } = fixture(phase === "fetch" ? { stalledFetch: true } : { stalledBody: true });
    const started = performance.now();
    const response = await handleTagFeedRequest(request(), options, source);
    assert.equal(response.status, 503);
    assert.ok(performance.now() - started < 1000);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init?.signal?.aborted, true);
    assert.equal(response.headers.get("etag"), null);
    assert.equal(await response.text(), "Tag feed temporarily unavailable.\n");
  });
}
