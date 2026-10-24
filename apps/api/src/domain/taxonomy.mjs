import { createHash } from "node:crypto";
import { ArticleInputError } from "./errors.mjs";

const TAXONOMY_KINDS = new Set(["category", "tag"]);

export function validateTaxonomyKind(value) {
  if (!TAXONOMY_KINDS.has(value)) throw new ArticleInputError("kind must be category or tag.");
  return value;
}


/**
 * Normalize a user-created hashtag. Display text remains Unicode while a
 * stable ASCII slug is generated for URLs/storage. NFKC and case folding
 * ensure routine spelling variants reuse the same global tag.
 */
export function normalizeHashtag(input) {
  if (typeof input !== "string") throw new ArticleInputError("tag name must be text.");
  let displayName = input.normalize("NFKC").trim();
  if (displayName.startsWith("#")) displayName = displayName.slice(1);
  displayName = displayName.normalize("NFKC");
  if (displayName.length < 1 || displayName.length > 50 ||
      !/^[\p{L}\p{M}\p{N}_-]+$/u.test(displayName)) {
    throw new ArticleInputError("tag name must be 1–50 Unicode letters, marks, numbers, underscores, or hyphens; whitespace and embedded # are not allowed.");
  }
  const canonical = displayName.toLowerCase();
  const asciiStem = canonical.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const suffix = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return {
    displayName,
    canonical,
    slug: asciiStem ? `${asciiStem}-${suffix}` : `tag-${suffix}`,
  };
}
