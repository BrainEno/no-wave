import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE_SLUG_MAX_LENGTH, slugifyArticleTitle, uniquifyArticleSlug } from "./article-slug.ts";

/**
 * Slug generation is contract-checked rather than string-compared: the pinyin
 * reading of a title depends on ICU's word segmentation, so the assertions pin
 * the properties that matter (ASCII, the stored slug pattern, length, stability,
 * and a readable prefix) instead of one exact transliteration.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHINESE_TITLES = [
  "你好世界",
  "无浪文学的第一篇文章",
  "关于「无浪」的一些想法",
  "重慶笔记",
  "雨夜里的旧书店",
];

test("Chinese titles become ASCII slugs that satisfy the stored slug contract", () => {
  for (const title of CHINESE_TITLES) {
    const slug = slugifyArticleTitle(title);
    assert.equal(
      slug.length > 0,
      true,
      `a Chinese title must never transliterate to an empty slug: ${title}`,
    );
    assert.match(slug, SLUG_PATTERN);
    assert.match(slug, /^[a-z]/, "the slug should start with a letter a reader can scan");
    assert.ok(slug.length <= ARTICLE_SLUG_MAX_LENGTH);
  }
});

test("Latin titles keep their words, drop punctuation and fold accents", () => {
  assert.equal(slugifyArticleTitle("Hello, World!"), "hello-world");
  assert.equal(slugifyArticleTitle("  Spring  Boot 3 实战：从零开始  "), "spring-boot-3-shizhan-cong-ling-kaishi");
  assert.equal(slugifyArticleTitle("Café — No Wave"), "cafe-no-wave");
});

test("mixed titles keep the Latin part and transliterate the Chinese part", () => {
  const slug = slugifyArticleTitle("AI 与文学的未来");
  assert.match(slug, SLUG_PATTERN);
  assert.equal(slug.startsWith("ai-"), true, `expected an "ai-" prefix, received ${slug}`);
  assert.equal(slug.includes("wenxue"), true, `expected the pinyin of 文学 in ${slug}`);
});

test("titles without transliterable content fall back to a stable hashed slug", () => {
  const first = slugifyArticleTitle("！！！");
  const second = slugifyArticleTitle("！！！");
  assert.match(first, /^article-[0-9a-f]{8}$/);
  assert.equal(first, second, "the fallback must be stable so retries do not drift");
  assert.match(slugifyArticleTitle(""), /^article-[0-9a-f]{8}$/);
  assert.match(slugifyArticleTitle(undefined), /^article-[0-9a-f]{8}$/);
  assert.equal(slugifyArticleTitle("🎉🎉"), slugifyArticleTitle("🎉🎉"));
});

test("slugs are stable, distinct per title, and capped at the contract length", () => {
  const slugs = CHINESE_TITLES.map((title) => slugifyArticleTitle(title));
  assert.equal(new Set(slugs).size, slugs.length);
  for (const title of CHINESE_TITLES) {
    assert.equal(slugifyArticleTitle(title), slugifyArticleTitle(title));
  }
  const long = slugifyArticleTitle("一个超长的中文标题用来测试长度上限截断行为以及连字符的处理方式与读音保留");
  assert.ok(long.length <= ARTICLE_SLUG_MAX_LENGTH, `capped slug is too long: ${long}`);
  assert.equal(long.endsWith("-"), false);
  assert.match(long, SLUG_PATTERN);
  assert.equal(slugifyArticleTitle("A".repeat(400)).length, ARTICLE_SLUG_MAX_LENGTH);
});

test("uniquify suffixes a counter and then a hash, and never returns an empty slug", () => {
  assert.equal(uniquifyArticleSlug("ni-hao", 1), "ni-hao");
  assert.equal(uniquifyArticleSlug("ni-hao", 0), "ni-hao");
  assert.equal(uniquifyArticleSlug("ni-hao", 2), "ni-hao-2");
  assert.equal(uniquifyArticleSlug("ni-hao", 20), "ni-hao-20");
  assert.match(uniquifyArticleSlug("ni-hao", 21), /^ni-hao-[0-9a-f]{8}$/);
  assert.match(uniquifyArticleSlug("", 3), /^article-3$/);
  assert.equal(
    uniquifyArticleSlug("ni-hao", 21),
    uniquifyArticleSlug("ni-hao", 21),
    "the hash suffix must be deterministic for the same attempt",
  );
});
