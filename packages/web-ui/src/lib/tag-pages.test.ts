import assert from "node:assert/strict";
import test from "node:test";
import type { ArticleView } from "./content.ts";
import { getArticleBySlug } from "./content.ts";
import { loadTagDetailPage, loadTagIndexPage, type TagPageSource } from "./tag-pages.ts";
import { TAG_MAX_PAGE, TAG_PAGE_SIZE, type TagView } from "./tag-discovery.ts";

const tag: TagView = { slug: "stable-tag", name: "记忆", description: "", locale: "zh-CN", articleCount: 22 };
const work = getArticleBySlug("portable-web-foundation");
assert.ok(work);
const works = Array.from({ length: 22 }, (_, index): ArticleView => ({ ...work, slug: `public-${index + 1}` }));
function fixture(overrides: Partial<TagPageSource> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const source: TagPageSource = {
    async listTags(options) { calls.push({ method: "listTags", args: [options] }); return Array.from({ length: 21 }, (_, i) => ({ ...tag, slug: `tag-${i}` })); },
    async getTag(...args) { calls.push({ method: "getTag", args }); return tag; },
    async listArticles(...args) { calls.push({ method: "listArticles", args }); return works; },
    ...overrides,
  };
  return { calls, source };
}

test("a directory page performs one lookahead request and returns exactly the visible page", async () => {
  const { source, calls } = fixture();
  const result = await loadTagIndexPage({ locale: "zh-CN", query: "　＃记忆　", page: 2 }, source);
  assert.deepEqual(calls, [{ method: "listTags", args: [{ locale: "zh-CN", query: "记忆", limit: 21, offset: 20 }] }]);
  assert.equal(result.query, "记忆");
  assert.equal(result.page, 2);
  assert.equal(result.tags.length, TAG_PAGE_SIZE);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.tags.at(-1)?.slug, "tag-19");
});

test("short and empty directory responses are successful data, never fallback catalogues", async () => {
  for (const tags of [[], [tag]]) {
    const { source } = fixture({ listTags: async () => tags });
    const result = await loadTagIndexPage({ locale: "en" }, source);
    assert.deepEqual(result.tags, tags);
    assert.equal(result.hasNextPage, false);
    assert.equal(result.locale, "en");
    assert.equal(result.page, 1);
  }
});

test("invalid directory pages cannot generate huge or non-finite offsets", async () => {
  for (const page of [-1, 0, 2.5, NaN, Infinity, TAG_MAX_PAGE + 1]) {
    const { source, calls } = fixture();
    const result = await loadTagIndexPage({ locale: "zh-CN", page }, source);
    assert.equal(result.page, 1);
    assert.deepEqual(calls[0].args, [{ locale: "zh-CN", query: "", limit: 21, offset: 0 }]);
  }
});

test("a detail page reads one identity and one bounded article page with the exact locale", async () => {
  const { source, calls } = fixture();
  const result = await loadTagDetailPage({ locale: "en", slug: tag.slug, page: 3 }, source);
  assert.deepEqual(calls, [
    { method: "getTag", args: [tag.slug, "en"] },
    { method: "listArticles", args: [tag.slug, "en", 21, 40] },
  ]);
  assert.equal(result.tag, tag);
  assert.equal(result.articles.length, 20);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.articles.at(-1)?.slug, "public-20");
});

test("unknown identity prevents the second lookup entirely", async () => {
  let identityReads = 0;
  const { source } = fixture({
    getTag: async () => { identityReads += 1; return null; },
    listArticles: async () => { throw new Error("An unknown tag must not request articles."); },
  });
  const result = await loadTagDetailPage({ locale: "zh-CN", slug: "unknown" }, source);
  assert.equal(result.tag, null);
  assert.deepEqual(result.articles, []);
  assert.equal(result.hasNextPage, false);
  assert.equal(identityReads, 1);
});

test("an invalid slug never touches either upstream operation", async () => {
  const { source, calls } = fixture();
  for (const slug of ["../private", "http://example.test", "标签", "a".repeat(161)]) {
    assert.equal((await loadTagDetailPage({ locale: "zh-CN", slug }, source)).tag, null);
  }
  assert.deepEqual(calls, []);
});

test("the tag identity read completes before the article read begins", async () => {
  const sequence: string[] = [];
  let finishIdentity: ((value: TagView) => void) | undefined;
  const identity = new Promise<TagView>((resolve) => { finishIdentity = resolve; });
  const { source } = fixture({
    getTag: async () => { sequence.push("identity"); return identity; },
    listArticles: async () => { sequence.push("articles"); return []; },
  });
  const pending = loadTagDetailPage({ locale: "zh-CN", slug: tag.slug }, source);
  assert.deepEqual(sequence, ["identity"]);
  assert.ok(finishIdentity);
  finishIdentity(tag);
  await pending;
  assert.deepEqual(sequence, ["identity", "articles"]);
});

test("removal between two reads is missing, but a known tag with zero works is not", async () => {
  const removed = await loadTagDetailPage({ locale: "zh-CN", slug: tag.slug }, fixture({ listArticles: async () => null }).source);
  assert.equal(removed.tag, null);
  assert.equal(removed.hasNextPage, false);
  const empty = await loadTagDetailPage({ locale: "zh-CN", slug: tag.slug }, fixture({ listArticles: async () => [] }).source);
  assert.equal(empty.tag, tag);
  assert.deepEqual(empty.articles, []);
  assert.equal(empty.hasNextPage, false);
});

test("the terminal Web page never advertises a next link beyond its supported offset window", async () => {
  const { source, calls } = fixture();
  const index = await loadTagIndexPage({ locale: "zh-CN", page: TAG_MAX_PAGE }, source);
  const detail = await loadTagDetailPage({ locale: "zh-CN", slug: tag.slug, page: TAG_MAX_PAGE }, source);
  assert.equal(index.hasNextPage, false);
  assert.equal(detail.hasNextPage, false);
  assert.deepEqual(calls[0].args, [{ locale: "zh-CN", query: "", limit: 21, offset: 100000 }]);
  assert.deepEqual(calls[2].args, [tag.slug, "zh-CN", 21, 100000]);
});

test("each upstream failure propagates rather than turning into a misleading successful empty state", async () => {
  const failure = new Error("unavailable");
  await assert.rejects(loadTagIndexPage({ locale: "zh-CN" }, fixture({ listTags: async () => { throw failure; } }).source), (error) => error === failure);
  await assert.rejects(loadTagDetailPage({ locale: "zh-CN", slug: tag.slug }, fixture({ getTag: async () => { throw failure; } }).source), (error) => error === failure);
  await assert.rejects(loadTagDetailPage({ locale: "zh-CN", slug: tag.slug }, fixture({ listArticles: async () => { throw failure; } }).source), (error) => error === failure);
});
