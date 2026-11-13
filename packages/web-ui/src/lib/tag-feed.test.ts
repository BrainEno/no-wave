import assert from "node:assert/strict";
import test from "node:test";
import type { ArticleView, Locale } from "./content.ts";
import type { TagView } from "./tag-discovery.ts";
import { parseTagFeedFormat, renderTagFeed, tagFeedLinks, tagFeedPath, TAG_FEED_LIMIT, type TagFeedInput } from "./tag-feed.ts";

const tag: TagView = { slug: "stable-theme", name: "地方與記憶", description: "獨立文學 & 閱讀", articleCount: 2, locale: "zh-CN" };
function work(overrides: Partial<ArticleView> = {}): ArticleView {
  return { slug: "remembered-place", title: "在海邊", description: "一段不含全文的摘要。", workType: "essay", contentBlocks: [],
    publishedAt: "2026-11-01T08:30:00.000Z", author: { username: "public-author", displayName: "寫作者", bio: "not-in-feed", locale: "zh-CN", availableLocales: ["zh-CN"] },
    categories: [], tags: [tag.name], locale: "zh-CN", availableLocales: ["zh-CN"], likeCount: 0, ...overrides };
}
function input(overrides: Partial<TagFeedInput> = {}): TagFeedInput {
  return { locale: "zh-CN", siteUrl: "https://configured.example/ignored-prefix/", format: "atom", tag, articles: [work()], ...overrides };
}

test("feed resource identities accept only the two explicit formats", () => {
  assert.equal(parseTagFeedFormat("atom"), "atom");
  assert.equal(parseTagFeedFormat("xml"), "rss");
  for (const value of [undefined, "rss", "json", "ATOM", "xml/extra", "../atom", "atom%00", 1]) assert.equal(parseTagFeedFormat(value), null);
  assert.equal(tagFeedPath(tag.slug, "zh-CN", "atom"), "/tags/stable-theme/feed.atom");
  assert.equal(tagFeedPath(tag.slug, "en", "rss"), "/en/tags/stable-theme/feed.xml");
  assert.equal(tagFeedPath(tag.slug, "zh-TW", "atom"), "/tags/stable-theme/feed.atom");
  assert.throws(() => tagFeedPath("../private", "en", "rss"), /tag slug/);
});

test("Atom advertises stable identities, plaintext summaries and its configured canonical origin", () => {
  const rendered = renderTagFeed(input());
  assert.equal(rendered.contentType, "application/atom+xml; charset=utf-8");
  assert.equal(rendered.self, "https://configured.example/tags/stable-theme/feed.atom");
  assert.equal(rendered.alternate, "https://configured.example/tags/stable-theme");
  assert.equal(rendered.updatedAt, "2026-11-01T08:30:00.000Z");
  assert.match(rendered.body, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom" xml:lang="zh-CN">/);
  assert.match(rendered.body, /<id>https:\/\/configured.example\/tags\/stable-theme<\/id>/);
  assert.match(rendered.body, /<link rel="self" type="application\/atom\+xml" href="https:\/\/configured.example\/tags\/stable-theme\/feed.atom"\/>/);
  assert.match(rendered.body, /<summary type="text">一段不含全文的摘要。<\/summary>/);
  assert.match(rendered.body, /<author><name>寫作者<\/name><\/author>/);
  assert.ok(!rendered.body.includes("ignored-prefix"));
  assert.ok(!rendered.body.includes("not-in-feed"));
});

test("RSS has an Atom self link, permalink GUIDs and RFC-style dates", () => {
  const rendered = renderTagFeed(input({ format: "rss" }));
  assert.equal(rendered.contentType, "application/rss+xml; charset=utf-8");
  assert.equal(rendered.self, "https://configured.example/tags/stable-theme/feed.xml");
  assert.match(rendered.body, /<rss version="2.0" xmlns:atom="http:\/\/www.w3.org\/2005\/Atom" xmlns:dc="http:\/\/purl.org\/dc\/elements\/1.1\/">/);
  assert.match(rendered.body, /<language>zh-CN<\/language>/);
  assert.match(rendered.body, /<atom:link href="https:\/\/configured.example\/tags\/stable-theme\/feed.xml" rel="self" type="application\/rss\+xml"\/>/);
  assert.match(rendered.body, /<guid isPermaLink="true">https:\/\/configured.example\/articles\/remembered-place<\/guid>/);
  assert.match(rendered.body, /<pubDate>Sun, 01 Nov 2026 08:30:00 GMT<\/pubDate>/);
  assert.match(rendered.body, /<lastBuildDate>Sun, 01 Nov 2026 08:30:00 GMT<\/lastBuildDate>/);
});

test("English feeds use only English resource paths and do not manufacture another translation", () => {
  const locale: Locale = "en";
  for (const format of ["atom", "rss"] as const) {
    const rendered = renderTagFeed(input({ locale, format, tag: { ...tag, locale, name: "Places & memory" }, articles: [work({ locale })] }));
    assert.equal(rendered.alternate, "https://configured.example/en/tags/stable-theme");
    assert.ok(rendered.body.includes("https://configured.example/en/articles/remembered-place"));
    assert.ok(!rendered.body.includes("hreflang"));
    assert.ok(!rendered.body.includes("/zh-TW/"));
  }
});

test("a renamed display label does not change tag identity or article GUIDs", () => {
  const original = renderTagFeed(input());
  const renamed = renderTagFeed(input({ tag: { ...tag, name: "另一個名稱" } }));
  assert.equal(original.self, renamed.self);
  assert.equal(original.alternate, renamed.alternate);
  assert.ok(renamed.body.includes("另一個名稱"));
  assert.ok(renamed.body.includes("/articles/remembered-place"));
  assert.notEqual(original.body, renamed.body, "the representation validator must notice a rename");
});

test("the bounded feed preserves authoritative order instead of sorting on an incomplete client page", () => {
  const articles = Array.from({ length: 25 }, (_, index) => work({ slug: `work-${index}`, publishedAt: index === 2 ? "2026-11-02T08:00:00Z" : work().publishedAt }));
  const rendered = renderTagFeed(input({ articles }));
  assert.equal(TAG_FEED_LIMIT, 20);
  assert.equal((rendered.body.match(/<entry>/g) ?? []).length, 20);
  assert.ok(rendered.body.indexOf("/articles/work-0") < rendered.body.indexOf("/articles/work-2"));
  assert.ok(rendered.body.includes("/articles/work-19"));
  assert.ok(!rendered.body.includes("/articles/work-20"));
  assert.equal(rendered.updatedAt, "2026-11-02T08:00:00.000Z");
  assert.equal(articles.length, 25, "rendering never mutates the source page");
});

test("empty public tags produce valid deterministic subscriptions, not a changing render timestamp", () => {
  for (const format of ["atom", "rss"] as const) {
    const empty = input({ articles: [], format, tag: { ...tag, articleCount: 0 } });
    const first = renderTagFeed(empty), second = renderTagFeed(empty);
    assert.equal(first.body, second.body);
    assert.equal(first.updatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal((first.body.match(/<entry>|<item>/g) ?? []).length, 0);
    assert.ok(first.body.includes("stable-theme"));
  }
});

test("author-controlled labels cannot escape XML attributes or install an external entity", () => {
  const attack = `\"><script>active()</script>&]]><!DOCTYPE x [<!ENTITY s SYSTEM "https://outside.test/">]>`;
  for (const format of ["atom", "rss"] as const) {
    const rendered = renderTagFeed(input({ format, tag: { ...tag, name: attack, description: attack }, articles: [work({ title: attack, description: attack })] }));
    assert.ok(!rendered.body.includes("<script>"));
    assert.ok(!rendered.body.includes("<!DOCTYPE"));
    assert.ok(!rendered.body.includes("<!ENTITY"));
    assert.ok(!rendered.body.includes("]]>"));
    assert.ok(!rendered.body.includes('href="https://outside.test/"'));
    assert.ok(rendered.body.includes("&lt;script&gt;"));
  }
});

test("RSS descriptions escape the HTML layer as well as XML, while Atom explicitly declares text", () => {
  const description = `<img src="x" onerror="active()"> & raw`;
  const atom = renderTagFeed(input({ articles: [work({ description })] }));
  assert.match(atom.body, /<summary type="text">&lt;img/);
  const rss = renderTagFeed(input({ format: "rss", articles: [work({ description })] }));
  assert.match(rss.body, /<description>&amp;lt;img src=&amp;quot;x&amp;quot;/);
  assert.ok(!rss.body.includes('<description>&lt;img'), "an RSS reader may interpret decoded descriptions as HTML");
});

test("only bounded public summaries are syndicated, never document blocks or author biographies", () => {
  const article = work({ description: "𠀀".repeat(500), contentBlocks: [{ id: "private-implementation-detail", type: "paragraph", text: "FULL-BODY-NOT-FOR-FEED" }] });
  const rendered = renderTagFeed(input({ articles: [article] }));
  const summary = /<summary type="text">(.*?)<\/summary>/.exec(rendered.body)?.[1] ?? "";
  assert.equal([...summary].length, 320);
  assert.ok(summary.endsWith("…"));
  assert.ok(!summary.includes("\ud840</"));
  assert.ok(!rendered.body.includes("FULL-BODY-NOT-FOR-FEED"));
  assert.ok(!rendered.body.includes("private-implementation-detail"));
});

test("unusable source origins cannot create credential-bearing or non-HTTP subscription URLs", () => {
  for (const siteUrl of ["", "relative/path", "javascript:active()", "file:///tmp/feed", "https://user:pass@site.example"]) {
    assert.throws(() => renderTagFeed(input({ siteUrl })), /public site origin/);
  }
  const rendered = renderTagFeed(input({ siteUrl: "https://site.example:8443/base/?secret=not-for-feed#fragment" }));
  assert.equal(rendered.self, "https://site.example:8443/tags/stable-theme/feed.atom");
  assert.ok(!rendered.body.includes("not-for-feed"));
  assert.ok(!rendered.body.includes("fragment"));
});

test("inconsistent resource identity and locale fail rather than mixing collections", () => {
  assert.throws(() => renderTagFeed(input({ tag: { ...tag, slug: "../../other" } })), /tag slug/);
  assert.throws(() => renderTagFeed(input({ tag: { ...tag, locale: "en" } })), /feed locale/);
  assert.throws(() => renderTagFeed(input({ articles: [work({ locale: "en" })] })), /feed locale/);
  assert.throws(() => renderTagFeed(input({ articles: [work(), work()] })), /duplicate article/);
  assert.throws(() => renderTagFeed(input({ articles: [work({ slug: "../admin" })] })), /article identity/);
  assert.throws(() => renderTagFeed(input({ articles: [work({ slug: "https://outside.test" })] })), /article identity/);
});

test("invalid required publication metadata fails the complete representation, not just one missing row", () => {
  for (const article of [work({ title: " " }), work({ publishedAt: "bad date" }), work({ author: { ...work().author, displayName: "" } })]) {
    assert.throws(() => renderTagFeed(input({ articles: [article] })), /metadata|timestamp/);
  }
  assert.throws(() => renderTagFeed(input({ tag: { ...tag, name: " " } })), /metadata/);
});

test("discovery links have format-specific MIME types, readable localized labels and no arbitrary query", () => {
  const chinese = tagFeedLinks(tag.slug, "zh-CN"), english = tagFeedLinks(tag.slug, "en");
  assert.deepEqual(chinese.map(({ type }) => type), ["application/atom+xml", "application/rss+xml"]);
  assert.deepEqual(chinese.map(({ href }) => href), ["/tags/stable-theme/feed.atom", "/tags/stable-theme/feed.xml"]);
  assert.deepEqual(english.map(({ href }) => href), ["/en/tags/stable-theme/feed.atom", "/en/tags/stable-theme/feed.xml"]);
  assert.ok(chinese.every(({ title }) => title.includes("订阅")));
  assert.ok(english.every(({ title }) => title.includes("Subscribe")));
});
