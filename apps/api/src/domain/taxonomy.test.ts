import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHashtag } from "./taxonomy.ts";

test("hashtag normalization preserves Unicode display text and canonicalizes equivalent forms", () => {
  const traditional = normalizeHashtag("#人工智慧");
  const noPrefix = normalizeHashtag("人工智慧");
  assert.equal(traditional.displayName, "人工智慧");
  assert.equal(traditional.slug, noPrefix.slug);
  assert.equal(normalizeHashtag("#ＡＩ").slug, normalizeHashtag("ai").slug);
  assert.equal(normalizeHashtag("#OpenAI").slug, normalizeHashtag("openai").slug);
});

test("hashtag normalization rejects embedded markers, whitespace and empty names", () => {
  for (const input of ["", "#", "two words", "bad#tag", "tag/name"]) {
    assert.throws(() => normalizeHashtag(input), { code: "BAD_USER_INPUT" });
  }
});
