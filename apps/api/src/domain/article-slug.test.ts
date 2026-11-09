import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE_SLUG_MAX_LENGTH, releasedArticleSlug, slugifyArticleTitle, stripDeletedSlugSuffix, uniquifyArticleSlug } from "./article-slug.ts";

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

/**
 * The tombstone address (#241).
 *
 * Deleting a work releases its public address by suffixing it; restoring tries to
 * give it back. The rules that make that a cycle rather than a ratchet are small
 * enough to live in one function, so they are pinned here: the suffix never
 * stacks, the result always fits the 160-character stored contract, and the
 * result is always a slug the same contract accepts.
 */
const ARTICLE_ID = "1a2b3c4d-0000-4000-8000-000000000000";

test("the tombstone suffix is stripped once per application, never partially", () => {
  assert.equal(stripDeletedSlugSuffix("a-story"), "a-story");
  assert.equal(stripDeletedSlugSuffix("a-story-deleted-1a2b3c4d"), "a-story");
  assert.equal(
    stripDeletedSlugSuffix("a-story-deleted-1a2b3c4d-deleted-1a2b3c4d"),
    "a-story",
    "a row that was deleted twice before the fix heals on its next delete",
  );
  // Only the tombstone shape at the end counts: a title may legitimately contain
  // the words, and truncating those would silently rename the work.
  assert.equal(stripDeletedSlugSuffix("deleted-notes"), "deleted-notes");
  assert.equal(stripDeletedSlugSuffix("a-deleted-1a2b3c4d-notes"), "a-deleted-1a2b3c4d-notes");
  assert.equal(stripDeletedSlugSuffix("a-deleted-1a2b3c"), "a-deleted-1a2b3c", "eight hex characters or it is not ours");
});

test("a released slug always fits the stored contract", () => {
  for (const length of [1, 2, 60, 143, 144, 150, 160]) {
    const slug = length <= 2 ? "a".repeat(length) : `w-${"a".repeat(length - 2)}`;
    const released = releasedArticleSlug(slug, ARTICLE_ID);
    assert.ok(released.length <= 160, `${length}: ${released.length} characters`);
    assert.match(released, SLUG_PATTERN, `${length}: ${released}`);
    assert.equal(released.endsWith(`-deleted-${ARTICLE_ID.slice(0, 8)}`), true);
  }
  // Truncation may land on a hyphen; the result must not end one segment early
  // with a trailing hyphen.
  const onHyphen = `a-${"b".repeat(141)}-tail`;
  const released = releasedArticleSlug(onHyphen, ARTICLE_ID);
  assert.match(released, SLUG_PATTERN);
  assert.equal(released.includes("--"), false);
});

test("releasing a released slug changes nothing, and a disambiguator still fits", () => {
  const once = releasedArticleSlug("a-story", ARTICLE_ID);
  assert.equal(releasedArticleSlug(once, ARTICLE_ID), once, "the second delete of the same work is a no-op on the suffix");
  assert.equal(once.split("-deleted-").length - 1, 1);

  const second = releasedArticleSlug("a-story", ARTICLE_ID, "-2");
  assert.equal(second, `${once}-2`, "a taken address steps aside instead of failing the delete");
  const long = releasedArticleSlug("w-" + "a".repeat(158), ARTICLE_ID, "-9");
  assert.ok(long.length <= 160, `${long.length} characters`);
  assert.match(long, SLUG_PATTERN);

  // Two different works cannot collide, because the id is the suffix.
  assert.notEqual(
    releasedArticleSlug("a-story", ARTICLE_ID),
    releasedArticleSlug("a-story", "ffffffff-0000-4000-8000-000000000000"),
  );
});

