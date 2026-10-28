import test from "node:test";
import assert from "node:assert/strict";
import { normalizeArticleInput, normalizeTaxonomyIds, validateArticleLocale, validateArticleSlug, validateArticleWorkType } from "./article.ts";

const blocks = [{ id: "paragraph-1", type: "paragraph", text: "A complete paragraph." }];

test("article domain model normalizes only the supported contract and rejects unsupported locales", () => {
  const article = normalizeArticleInput({
    slug: "a-new-article",
    title: "A new article",
    locale: "en",
    contentBlocks: blocks,
    publish: true,
  });
  assert.equal(article.slug, "a-new-article");
  assert.equal(article.summary, "");
  assert.equal(article.publish, true);
  assert.equal(article.contentBlocksVersion, 0);
  assert.deepEqual(article.contentBlocks, blocks);
  assert.throws(() => validateArticleLocale("fr"), { code: "BAD_USER_INPUT" });
  assert.throws(() => validateArticleSlug("Bad Slug"), { code: "BAD_USER_INPUT" });
});

test("article content blocks are validated independently from persistence", () => {
  assert.throws(() => normalizeArticleInput({
    slug: "article",
    title: "Bad body",
    locale: "zh-TW",
    contentBlocks: [{ id: "bad", type: "unsupported" }],
  }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    slug: "article",
    title: "Duplicate block IDs",
    locale: "zh-TW",
    contentBlocks: [
      { id: "same", type: "paragraph", text: "One" },
      { id: "same", type: "paragraph", text: "Two" },
    ],
  }), { code: "BAD_USER_INPUT" });
});

test("taxonomy association IDs reject malformed and duplicate identifiers before persistence", () => {
  assert.deepEqual(normalizeTaxonomyIds("tagIds", [], 50), []);
  assert.throws(() => normalizeTaxonomyIds("tagIds", ["not-a-uuid"], 50), { code: "BAD_USER_INPUT" });
  const id = "bdb4ec86-22d3-4eaf-96db-34b7b5a63bb8";
  assert.throws(() => normalizeTaxonomyIds("tagIds", [id, id], 50), { code: "BAD_USER_INPUT" });
});


test("literary work types are explicit and reject unknown values", () => {
  assert.equal(validateArticleWorkType("poetry"), "poetry");
  assert.equal(normalizeArticleInput({ slug: "poem", title: "A poem", locale: "zh-CN", workType: "poetry", contentBlocks: blocks }).workType, "poetry");
  assert.throws(() => validateArticleWorkType("viral-post"), { code: "BAD_USER_INPUT" });
  assert.equal(validateArticleLocale("zh-CN"), "zh-CN");
});


test("article content version 1 preserves validated inline marks and safe links", () => {
  const contentBlocks = [
    {
      id: "intro",
      type: "paragraph",
      text: "A bold word and link.",
      inlines: [
        { text: "A " },
        { text: "bold", marks: ["bold"] },
        { text: " word and " },
        { text: "link", marks: ["italic"], href: "/authors/beck" },
        { text: "." },
      ],
    },
    {
      id: "list",
      type: "list",
      ordered: false,
      items: ["A linked item"],
      itemInlines: [[{ text: "A linked item", href: "https://example.test/item", marks: ["underline"] }]],
    },
  ];
  const article = normalizeArticleInput({
    slug: "rich-text-article", title: "Rich text", locale: "zh-CN",
    contentBlocksVersion: 1, contentBlocks,
  });
  assert.equal(article.contentBlocksVersion, 1);
  assert.deepEqual(article.contentBlocks, contentBlocks);
});

test("article rich text rejects unknown versions, lossy fallbacks and unsafe links", () => {
  const base = { slug: "invalid-rich-text", title: "Invalid rich text", locale: "zh-CN", contentBlocksVersion: 1 };
  assert.throws(() => normalizeArticleInput({ ...base, contentBlocksVersion: 2, contentBlocks: blocks }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    ...base, contentBlocks: [{ id: "p1", type: "paragraph", text: "Expected", inlines: [{ text: "Different" }] }],
  }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    ...base, contentBlocks: [{ id: "p1", type: "paragraph", text: "Click", inlines: [{ text: "Click", href: "javascript:alert(1)" }] }],
  }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    ...base, contentBlocks: [{ id: "p1", type: "paragraph", text: "Click", inlines: [{ text: "Click", href: "//evil.example/path" }] }],
  }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    slug: "legacy-rich-text", title: "Legacy payload", locale: "zh-CN",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "Click", inlines: [{ text: "Click", marks: ["bold"] }] }],
  }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    ...base, contentBlocks: [{ id: "p1", type: "paragraph", text: "Click", inlines: [{ text: "Click", marks: ["blink"] }] }],
  }), { code: "BAD_USER_INPUT" });
});

test("article content validator bounds serialized document size and rejects unsupported block fields", () => {
  assert.throws(() => normalizeArticleInput({
    slug: "unknown-field", title: "Unknown field", locale: "zh-CN",
    contentBlocks: [{ id: "p1", type: "paragraph", text: "Text", html: "<script>alert(1)</script>" }],
  }), { code: "BAD_USER_INPUT" });
  assert.throws(() => normalizeArticleInput({
    slug: "large-content", title: "Large content", locale: "zh-CN",
    contentBlocks: [{ id: "code", type: "code", language: "text", code: "x".repeat(1_000_001) }],
  }), { code: "BAD_USER_INPUT" });
});
