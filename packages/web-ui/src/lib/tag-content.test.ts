import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTimeoutError } from "@bot-thk/web-http";
import { createApiContentClient, getPublicTag, listPublicTagArticles, listPublicTags } from "./api-content.ts";

const tag = { slug: "stable-topic-123", name: "地方与记忆", description: "不同语言下的文学主题。", locale: "zh-CN", articleCount: 3 };
const article = {
  slug: "public-work", title: "公开作品", status: "published", summary: "独立摘要", workType: "essay",
  contentBlocks: [{ id: "paragraph", type: "paragraph", text: "公开正文" }], publishedAt: "2026-11-01T00:00:00.000Z",
  author: { userId: "writer", displayName: "作者", bio: "" }, categories: [], tags: [tag],
};
function reply(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}
function clientFor(data: unknown, status = 200) {
  return createApiContentClient({ endpoint: "https://api.example.test", fetchImpl: async () => reply({ data }, status) });
}

test("tag list requests preserve Unicode search, pagination and anonymous deadline-bound GET semantics", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = createApiContentClient({ endpoint: "https://api.example.test/prefix/", fetchImpl: async (input, init) => {
    calls.push({ url: new URL(input), init });
    return reply({ data: [tag] });
  } });
  assert.deepEqual(await client.listTags({ locale: "zh-CN", query: "地方", limit: 21, offset: 40 }), [tag]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/prefix/api/v1/tags");
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { locale: "zh-CN", query: "地方", limit: "21", offset: "40" });
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(calls[0].init?.cache, "no-store");
  assert.deepEqual(calls[0].init?.headers, { accept: "application/json" });
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
});

test("tag detail retains persisted identity even when its display name has changed", async () => {
  const renamed = { ...tag, name: "完全不同的名称" };
  const calls: string[] = [];
  const client = createApiContentClient({ endpoint: "https://api.example.test", fetchImpl: async (input) => {
    calls.push(new URL(input).pathname);
    return reply({ data: renamed });
  } });
  assert.deepEqual(await client.getTagBySlug(tag.slug), renamed);
  assert.deepEqual(calls, [`/api/v1/tags/${tag.slug}`]);
});

test("only an HTTP 404 maps to missing tag identity or a missing article collection", async () => {
  let jsonReads = 0;
  const client = createApiContentClient({ endpoint: "https://api.example.test", fetchImpl: async () => ({
    ok: false, status: 404, async json() { jsonReads += 1; throw new Error("A missing response body is irrelevant."); },
  }) });
  assert.equal(await client.getTagBySlug("missing"), null);
  assert.equal(await client.listTagArticles("missing"), null);
  assert.equal(jsonReads, 0);
  assert.deepEqual(await clientFor([]).listTags(), []);
  assert.deepEqual(await clientFor([]).listTagArticles(tag.slug), []);
});

test("successful nulls and malformed lists cannot masquerade as empty or missing tags", async () => {
  for (const value of [null, {}, { slug: "x" }, "not-a-list", 3]) {
    await assert.rejects(clientFor(value).listTags(), /invalid public tag list/);
    await assert.rejects(clientFor(value).getTagBySlug(tag.slug), /invalid public tag/);
    await assert.rejects(clientFor(value).listTagArticles(tag.slug), /invalid public tag article list/);
  }
});

test("tag records reject invalid slugs, labels, counts, locale drift and non-text descriptions", async () => {
  const invalid = [
    { ...tag, slug: "javascript:alert(1)" }, { ...tag, slug: "../outside" }, { ...tag, slug: "A" },
    { ...tag, slug: "a".repeat(161) }, { ...tag, name: " " }, { ...tag, name: 3 },
    { ...tag, articleCount: -1 }, { ...tag, articleCount: 1.5 }, { ...tag, articleCount: NaN },
    { ...tag, articleCount: Number.MAX_SAFE_INTEGER + 1 }, { ...tag, articleCount: "3" },
    { ...tag, locale: "en" }, { ...tag, description: { html: "unsafe" } },
  ];
  for (const value of invalid) {
    await assert.rejects(clientFor([value]).listTags(), /invalid public tag/);
    await assert.rejects(clientFor(value).getTagBySlug(tag.slug), /invalid public tag/);
  }
  const optional = { slug: tag.slug, name: tag.name, articleCount: 0, description: null };
  assert.deepEqual(await clientFor(optional).getTagBySlug(tag.slug), { ...tag, description: "", articleCount: 0 });
});

test("tag articles use the locale-specific collection and retain safe references without losing legacy names", async () => {
  const calls: URL[] = [];
  const client = createApiContentClient({ endpoint: "https://api.example.test", fetchImpl: async (input) => {
    calls.push(new URL(input));
    return reply({ data: [{ ...article, tags: [tag, { name: "旧名称" }, { name: "坏链接", slug: "//outside.test" }] }] });
  } });
  const works = await client.listTagArticles(tag.slug, "en", 21, 20);
  assert.ok(works);
  assert.equal(works[0].locale, "en");
  assert.deepEqual(works[0].tags, [tag.name, "旧名称", "坏链接"]);
  assert.deepEqual(works[0].tagReferences, [{ slug: tag.slug, name: tag.name }]);
  assert.equal(calls[0].pathname, `/api/v1/tags/${tag.slug}/articles`);
  assert.deepEqual(Object.fromEntries(calls[0].searchParams), { locale: "en", limit: "21", offset: "20" });
});

test("a draft or malformed article response fails closed instead of being silently filtered", async () => {
  for (const value of [{ ...article, status: "draft" }, { ...article, status: "deleted" }, { ...article, status: undefined }]) {
    await assert.rejects(clientFor([value]).listTagArticles(tag.slug), /non-public tag article/);
  }
  await assert.rejects(clientFor([{ ...article, author: null }]).listTagArticles(tag.slug), /invalid public tag article/);
  await assert.rejects(clientFor([{ ...article, contentBlocks: "not-json" }]).listTagArticles(tag.slug), /malformed article content/);
});

test("optional article references are additive for ordinary article reads as well as tag collections", async () => {
  const result = await clientFor({ ...article, tags: [tag, { name: "legacy" }] }).getArticleBySlug(article.slug);
  assert.ok(result);
  assert.deepEqual(result.tags, [tag.name, "legacy"]);
  assert.deepEqual(result.tagReferences, [{ slug: tag.slug, name: tag.name }]);
  const legacy = await clientFor({ ...article, tags: [{ name: "legacy" }] }).getArticleBySlug(article.slug);
  assert.deepEqual(legacy?.tags, ["legacy"]);
  assert.deepEqual(legacy?.tagReferences, []);
});

test("invalid tag paths never reach fetch, including double encodings and URL schemes", async () => {
  let calls = 0;
  const client = createApiContentClient({ endpoint: "https://api.example.test", fetchImpl: async () => { calls += 1; return reply({ data: tag }); } });
  for (const slug of ["", "%2e%2e", "a/b", "//example.test", "javascript:alert(1)", "标签", "a".repeat(161)]) {
    await assert.rejects(client.getTagBySlug(slug), /Invalid public tag slug/);
    await assert.rejects(client.listTagArticles(slug), /Invalid public tag slug/);
  }
  assert.equal(calls, 0);
});

test("HTTP failures and error envelopes surface without forwarding upstream diagnostic text", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(clientFor([], status).listTags(), new RegExp(`HTTP ${status}`));
    await assert.rejects(clientFor(tag, status).getTagBySlug(tag.slug), new RegExp(`HTTP ${status}`));
  }
  const client = createApiContentClient({ endpoint: "https://api.example.test", fetchImpl: async () => reply({
    error: { code: "UNAVAILABLE", message: "private upstream diagnostic" },
  }) });
  await assert.rejects(client.listTags(), (error: unknown) => error instanceof Error && /UNAVAILABLE/.test(error.message) && !error.message.includes("private upstream diagnostic"));
});

test("the tag request deadline includes a JSON body that never finishes", async () => {
  const keepAlive = setTimeout(() => undefined, 1000);
  const client = createApiContentClient({ endpoint: "https://api.example.test", timeoutMs: 20, fetchImpl: async () => ({
    ok: true, status: 200, json: () => new Promise<unknown>(() => undefined),
  }) });
  try { await assert.rejects(client.listTags(), UpstreamTimeoutError); }
  finally { clearTimeout(keepAlive); }
});

test("an unconfigured instance never invents tags or performs a network request", async () => {
  const keys = ["API_BASE_URL", "API_SERVICE_URL", "API_GRAPHQL_URL"] as const;
  const saved = keys.map((key) => process.env[key]);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  for (const key of keys) delete process.env[key];
  globalThis.fetch = async () => { calls += 1; throw new Error("Unexpected network request."); };
  try {
    assert.deepEqual(await listPublicTags(), []);
    assert.equal(await getPublicTag(tag.slug), null);
    assert.equal(await listPublicTagArticles(tag.slug), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [index, key] of keys.entries()) {
      const value = saved[index];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
