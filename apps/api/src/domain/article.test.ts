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
