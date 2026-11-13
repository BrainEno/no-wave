import assert from "node:assert/strict";
import test from "node:test";
import { articleTagItems, isTagSlug, tagDetailHref, tagDetailMetadata, tagIndexHref, tagIndexMetadata, tagIndexPath, tagPage, tagPath,
  tagSearchQuery, TAG_MAX_PAGE, TAG_QUERY_LIMIT, type TagView } from "./tag-discovery.ts";
import { getTagCopy } from "./tag-copy.ts";

const tag: TagView = { slug: "persisted-slug-123", name: "海边的记忆", description: "", articleCount: 1, locale: "zh-CN" };

test("public tag identity is a bounded ASCII slug, not its Unicode display name", () => {
  for (const value of ["tag-a1", "a", "1", "a".repeat(160)]) assert.equal(isTagSlug(value), true, value);
  for (const value of [null, undefined, 3, "", "a".repeat(161), "a_b", "A", "-a", "a-", "a--b", "海边", "../a", "a/b", "a%2fb", "a?b", "//example.test"]) {
    assert.equal(isTagSlug(value), false, String(value));
  }
  assert.equal(tagPath(tag.slug, "zh-CN"), `/tags/${tag.slug}`);
  assert.equal(tagPath(tag.slug, "en"), `/en/tags/${tag.slug}`);
  assert.throws(() => tagPath("javascript:alert(1)", "zh-CN"), /Invalid public tag slug/);
});

test("tag search accepts common hashtag input forms without changing the stored label or slug", () => {
  assert.equal(tagSearchQuery("　＃ＡＢＣ　"), "ABC");
  assert.equal(tagSearchQuery(" # 海边的记忆 "), "海边的记忆");
  assert.equal(tagSearchQuery("Cafe\u0301"), "Café");
  assert.equal(tagSearchQuery("  "), "");
  assert.equal(tagSearchQuery("#"), "");
  assert.equal(tagSearchQuery("无#关"), "无#关", "only the optional leading marker is removed");
  assert.equal(tag.name, "海边的记忆");
  assert.equal(tag.slug, "persisted-slug-123");
});

test("the query cap agrees with API UTF-16 length and preserves whole supplementary characters", () => {
  assert.equal(tagSearchQuery("字".repeat(TAG_QUERY_LIMIT + 10)), "字".repeat(TAG_QUERY_LIMIT));
  const supplementary = "𠀀";
  assert.equal(tagSearchQuery(supplementary.repeat(101)), supplementary.repeat(100));
  const edge = tagSearchQuery("a".repeat(199) + supplementary + "z");
  assert.equal(edge, "a".repeat(199));
  assert.equal(edge.endsWith("\ud840"), false, "a truncated high surrogate is not a valid search term");
});

test("URL builders preserve query and locale, omit page one and normalize invalid pages", () => {
  assert.equal(tagIndexPath("en"), "/en/tags");
  assert.equal(tagIndexPath("zh-TW"), "/tags", "this slice adds no unsupported zh-TW route");
  assert.equal(tagIndexHref("zh-CN", "#海边", 1), "/tags?q=%E6%B5%B7%E8%BE%B9");
  assert.equal(tagIndexHref("en", "a & b", 2), "/en/tags?q=a+%26+b&page=2");
  assert.equal(tagDetailHref(tag.slug, "en", 1), `/en/tags/${tag.slug}`);
  assert.equal(tagDetailHref(tag.slug, "en", 3), `/en/tags/${tag.slug}?page=3`);
  for (const value of [undefined, "0", "-1", "2garbage", "2.5", "NaN", Infinity, NaN, TAG_MAX_PAGE + 1]) assert.equal(tagPage(value), 1);
  assert.equal(tagPage(TAG_MAX_PAGE), TAG_MAX_PAGE);
  assert.equal(tagPage("2"), 2);
});

test("article references never manufacture identity, drop legacy labels or create foreign links", () => {
  const entries = articleTagItems(["旧名称", "重命名", "坏链接", "重命名"], [
    { slug: "stable-before-rename", name: "重命名" },
    { slug: "//outside.test", name: "坏链接" },
    { slug: "not-in-article", name: "不属于本文" },
  ]);
  assert.deepEqual(entries, [{ name: "旧名称", slug: null }, { name: "重命名", slug: "stable-before-rename" }, { name: "坏链接", slug: null }]);
  assert.deepEqual(articleTagItems(["只有名称"]), [{ name: "只有名称", slug: null }]);
  assert.deepEqual(articleTagItems([]), []);
});

test("directory metadata canonicalizes the visible query page and controls arbitrary-query indexing", () => {
  const meta = tagIndexMetadata("en", "＃海边", 2, "https://configured.example/base/");
  assert.equal(meta.title, "Tags · Page 2");
  assert.equal(meta.robots, "noindex, follow");
  assert.equal(meta.alternates.canonical, "https://configured.example/en/tags?q=%E6%B5%B7%E8%BE%B9&page=2");
  assert.equal(meta.openGraph.url, meta.alternates.canonical);
  assert.equal(meta.openGraph.locale, "en_US");
  assert.equal(tagIndexMetadata("zh-CN", "", 1).robots, "index, follow");
  assert.equal(tagIndexMetadata("zh-CN", "", 1).alternates.canonical, "https://example.invalid/tags");
});

test("tag metadata uses the stored name and page, without inventing translation alternates", () => {
  const meta = tagDetailMetadata(tag, "zh-CN", 2, "https://configured.example");
  assert.equal(meta.title, "#海边的记忆 · 第 2 页");
  assert.match(meta.description, /海边的记忆/);
  assert.equal(meta.alternates.canonical, `https://configured.example/tags/${tag.slug}?page=2`);
  assert.equal(meta.openGraph.url, meta.alternates.canonical);
  assert.equal(meta.openGraph.locale, "zh_CN");
  assert.deepEqual(Object.keys(meta.alternates), ["canonical"]);
  assert.equal(tagDetailMetadata({ ...tag, description: "Author supplied description" }, "en").description, "Author supplied description");
});

test("tag copy has the same complete action vocabulary in each supported data locale", () => {
  const chinese = getTagCopy("zh-CN"), traditional = getTagCopy("zh-TW"), english = getTagCopy("en");
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(traditional).sort());
  assert.equal(traditional.title, "標籤");
  assert.equal(english.works(1), "1 published work");
  assert.equal(english.works(0), "0 published works");
  assert.ok(chinese.articleTags && chinese.queryHint && english.firstPage);
});
