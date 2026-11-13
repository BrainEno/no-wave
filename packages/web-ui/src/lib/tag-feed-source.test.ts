import assert from "node:assert/strict";
import test from "node:test";
import { createApiContentClient } from "./api-content.ts";
import { renderTagFeed } from "./tag-feed.ts";
import type { TagView } from "./tag-discovery.ts";

const tag: TagView = { slug: "public-theme", name: "记忆", description: "", articleCount: 1, locale: "zh-CN" };
const article = { slug: "public-work", title: "公开的作品", status: "published", locale: "zh-CN", workType: "essay", summary: "已编辑的摘要",
  contentBlocks: [], publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-11-02T12:00:00.000Z",
  author: { userId: "writer", displayName: "作者", bio: "只属于作者页面的介绍" }, tags: [tag], categories: [] };
function clientFor(value: unknown) {
  return createApiContentClient({ endpoint: "https://independent-api.example", fetchImpl: async () => ({
    ok: true, status: 200, async json() { return { data: value }; },
  }) });
}

test("tag article projection retains the API modification instant separately from its publication instant", async () => {
  const mapped = await clientFor([article]).listTagArticles(tag.slug, "zh-CN");
  assert.ok(mapped);
  assert.equal(mapped[0].publishedAt, article.publishedAt);
  assert.equal(mapped[0].updatedAt, article.updatedAt);
  assert.equal(mapped[0].description, article.summary);
  assert.equal(article.updatedAt, "2026-11-02T12:00:00.000Z", "the upstream object is not rewritten");
  const rendered = renderTagFeed({ tag, articles: mapped, locale: "zh-CN", siteUrl: "https://site.example", format: "atom" });
  assert.equal(rendered.updatedAt, article.updatedAt);
  assert.match(rendered.body, /<published>2026-10-01T00:00:00.000Z<\/published>/);
  assert.match(rendered.body, /<updated>2026-11-02T12:00:00.000Z<\/updated>/);
});

test("ordinary public article reads receive the same additive optional modification field", async () => {
  const mapped = await clientFor(article).getArticleBySlug(article.slug, "zh-CN");
  assert.ok(mapped);
  assert.equal(mapped.updatedAt, article.updatedAt);
  assert.equal(mapped.slug, article.slug);
  assert.equal(mapped.title, article.title);
  assert.deepEqual(mapped.tags, [tag.name]);
});

test("legacy responses without a modification field stay readable and use the known publication instant", async () => {
  for (const updatedAt of [undefined, null]) {
    const mapped = await clientFor([{ ...article, updatedAt }]).listTagArticles(tag.slug);
    assert.ok(mapped);
    assert.equal(mapped[0].updatedAt, undefined);
    const atom = renderTagFeed({ tag, articles: mapped, locale: "zh-CN", siteUrl: "https://site.example", format: "atom" });
    assert.equal(atom.updatedAt, article.publishedAt);
    assert.ok(atom.body.includes(`<updated>${article.publishedAt}</updated>`));
  }
});

test("a successful collection claiming the wrong locale is rejected before it can masquerade as a translation", async () => {
  for (const locale of ["en", "zh-TW", "fr", null, 1, {}]) {
    await assert.rejects(clientFor([{ ...article, locale }]).listTagArticles(tag.slug, "zh-CN"), /tag article locale/);
  }
  const legacy = { ...article, locale: undefined };
  const mapped = await clientFor([legacy]).listTagArticles(tag.slug, "zh-CN");
  assert.equal(mapped?.[0].locale, "zh-CN", "the documented legacy shape may omit the explicit locale");
});

test("a tag collection cannot invent a publication instant from updatedAt or createdAt", async () => {
  for (const publishedAt of [undefined, null, "", 7]) {
    const value = { ...article, publishedAt, createdAt: "2026-09-01T00:00:00.000Z" };
    await assert.rejects(clientFor([value]).listTagArticles(tag.slug), /publication metadata/);
  }
});

test("non-text modification metadata is an upstream contract failure, not a silent legacy downgrade", async () => {
  for (const updatedAt of [7, false, {}, []]) {
    await assert.rejects(clientFor([{ ...article, updatedAt }]).listTagArticles(tag.slug), /modification metadata/);
  }
  const mapped = await clientFor([{ ...article, updatedAt: "not-a-date" }]).listTagArticles(tag.slug);
  assert.ok(mapped);
  assert.throws(() => renderTagFeed({ tag, articles: mapped, locale: "zh-CN", siteUrl: "https://site.example", format: "rss" }), /publication timestamp/);
});

test("a publication after an older modification clock remains the latest known significant instant", async () => {
  const mapped = await clientFor([{ ...article, updatedAt: "2026-09-01T00:00:00.000Z" }]).listTagArticles(tag.slug);
  assert.ok(mapped);
  const rendered = renderTagFeed({ tag, articles: mapped, locale: "zh-CN", siteUrl: "https://site.example", format: "atom" });
  assert.equal(rendered.updatedAt, article.publishedAt);
  assert.match(rendered.body, /<updated>2026-10-01T00:00:00.000Z<\/updated>/);
});

test("historical publication instants before 1970 are not replaced with the empty-feed sentinel", async () => {
  const publishedAt = "1960-01-01T00:00:00.000Z";
  const mapped = await clientFor([{ ...article, publishedAt, updatedAt: undefined }]).listTagArticles(tag.slug);
  assert.ok(mapped);
  const rendered = renderTagFeed({ tag, articles: mapped, locale: "zh-CN", siteUrl: "https://site.example", format: "atom" });
  assert.equal(rendered.updatedAt, publishedAt);
});
