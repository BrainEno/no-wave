import { createHash } from "node:crypto";
import { pinyin } from "pinyin-pro";

/**
 * Article slug generation.
 *
 * The public article address is `/articles/<slug>` and the stored contract is
 * ASCII-only (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so a slug is never authored by
 * hand: it is derived from the title when the client does not supply one.
 *
 * Chinese titles are transliterated to tone-less pinyin instead of being
 * dropped. Dropping them (what a naive ASCII filter does) turns most titles of
 * this site into an empty string, and percent-encoded Han in a path is hostile
 * to sharing and to Baidu, which reads pinyin in URLs. Words are segmented
 * first (`Intl.Segmenter`, the same ICU data the rest of the stack already
 * uses) so syllables group per word: `无浪文学的第一篇文章` becomes
 * `wu-lang-wenxue-de-di-yipian-wenzhang` rather than a 30-character blob.
 */
export const ARTICLE_SLUG_MAX_LENGTH = 60;
export const ARTICLE_SLUG_FALLBACK_PREFIX = "article";
const MAX_UNIQUE_ATTEMPTS = 20;
const HAN = /\p{Script=Han}/u;
const SYLLABLE = /^[a-z]+$/;
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Eight hex characters are enough to disambiguate a title-derived slug. */
function shortDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/** Lower-case ASCII folding: `Café` -> `cafe`, `AI 与文学` -> `ai`. */
function asciiToken(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().replace(NON_ALPHANUMERIC, "");
}

function wordSegments(title: string, locale: string): { segment: string; isWordLike: boolean }[] {
  if (typeof Intl.Segmenter === "function") {
    try {
      return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(title)]
        .map((item) => ({ segment: item.segment, isWordLike: item.isWordLike !== false }));
    } catch {
      // An unknown locale must not break article creation; fall through to the
      // punctuation split below.
    }
  }
  return title.split(/[^\p{L}\p{N}'’]+/u).filter((segment) => segment.length > 0)
    .map((segment) => ({ segment, isWordLike: true }));
}

function joinWithinLength(tokens: string[], maxLength: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const token of tokens) {
    const next = length + token.length + (kept.length > 0 ? 1 : 0);
    if (next > maxLength) break;
    kept.push(token);
    length = next;
  }
  if (kept.length > 0) return kept.join("-");
  // A single token longer than the cap: hard-cut it rather than dropping the
  // slug entirely.
  return tokens.length > 0 ? tokens[0].slice(0, maxLength).replace(/-+$/, "") : "";
}

/**
 * Derive an ASCII article slug from a title. Returns a non-empty slug: when
 * the title carries no transliterable content (punctuation, emoji, …) the
 * result is `<prefix>-<hash>`, which is stable for the same title.
 */
export function slugifyArticleTitle(
  title: unknown,
  { locale = "zh-CN", maxLength = ARTICLE_SLUG_MAX_LENGTH }: { locale?: string; maxLength?: number } = {},
): string {
  const source = typeof title === "string" ? title.normalize("NFC") : "";
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : ARTICLE_SLUG_MAX_LENGTH;
  const tokens: string[] = [];
  for (const { segment, isWordLike } of wordSegments(source, locale)) {
    const word = segment.trim();
    if (word.length === 0) continue;
    if (!isWordLike && !HAN.test(word)) continue;
    if (HAN.test(word)) {
      // pinyin-pro returns one entry per Han character and passes non-Chinese
      // runs through verbatim, so mixed words keep their Latin part.
      const syllables = pinyin(word, { toneType: "none", type: "array" });
      const token = syllables
        .map((entry) => (SYLLABLE.test(entry) ? entry : asciiToken(entry)))
        .filter((entry) => entry.length > 0)
        .join("");
      if (token.length > 0) tokens.push(token);
      continue;
    }
    const token = asciiToken(word);
    if (token.length > 0) tokens.push(token);
  }
  return joinWithinLength(tokens, limit) || `${ARTICLE_SLUG_FALLBACK_PREFIX}-${shortDigest(source)}`;
}

/**
 * The nth attempt at storing `base`: `1` is the slug itself, `2..20` append a
 * counter, and anything beyond that falls back to a hash suffix so a long run
 * of same-titled articles cannot loop forever.
 */
export function uniquifyArticleSlug(base: string, attempt: number): string {
  const slug = typeof base === "string" && base.length > 0 ? base : ARTICLE_SLUG_FALLBACK_PREFIX;
  if (!Number.isInteger(attempt) || attempt <= 1) return slug;
  if (attempt <= MAX_UNIQUE_ATTEMPTS) return `${slug}-${attempt}`;
  return `${slug}-${shortDigest(`${slug}#${attempt}`)}`;
}

/**
 * The suffix a tombstone carries, and the address it releases.
 *
 * Deleting a work has to give up its public address: otherwise rewriting the
 * same title afterwards collides with the tombstone forever, with a 409 the
 * author cannot resolve. The tombstone therefore becomes
 * `<slug>-deleted-<id8>` — unique by construction, because the id is.
 *
 * Two invariants have to survive (#241):
 *
 * 1. **The suffix is never stacked.** Restoring a tombstone whose original
 *    address has been taken keeps the suffixed slug (a restore must never fail
 *    over an address the author cannot see), so the *next* delete of that same
 *    work used to append a second `-deleted-…`. Seventeen characters per
 *    cycle, forever.
 * 2. **The result is a valid slug.** A 155-character address plus a 17-character
 *    suffix is 172, and `validateArticleSlug` refuses anything over 160 — so the
 *    restored draft could be deleted but never saved again. The base is
 *    truncated to whatever the suffix leaves room for.
 */
export const DELETED_SLUG_SUFFIX_LENGTH = 17;

/** The longest address the stored contract accepts (see `validateArticleSlug`). */
const MAX_STORED_SLUG_LENGTH = 160;

const DELETED_SUFFIX_AT_END = /-deleted-[0-9a-f]{8}$/i;

/**
 * The address without its tombstone suffix, as many times as it was applied.
 *
 * Looping rather than stripping once, so a row that already carries two (from a
 * delete/restore cycle that happened before this fix) heals on its next delete
 * instead of keeping the older suffix forever.
 */
export function stripDeletedSlugSuffix(slug: string): string {
  let base = typeof slug === "string" ? slug : "";
  while (DELETED_SUFFIX_AT_END.test(base)) base = base.replace(DELETED_SUFFIX_AT_END, "");
  return base;
}

/**
 * The slug a tombstone gets when `slug` is released.
 *
 * `disambiguator` exists for the one case the id cannot settle: a *live* work
 * already holding the exact address this tombstone wants (somebody typed
 * `foo-deleted-1a2b3c4d` as a title). The store retries with `-2`, `-3`, … rather
 * than letting a unique index turn a delete into a 500.
 */
export function releasedArticleSlug(slug: string, articleId: string, disambiguator = ""): string {
  const suffix = `-deleted-${String(articleId).slice(0, 8).toLowerCase()}${disambiguator}`;
  const room = Math.max(1, MAX_STORED_SLUG_LENGTH - suffix.length);
  const base = stripDeletedSlugSuffix(slug).slice(0, room).replace(/-+$/, "");
  const fallback = ARTICLE_SLUG_FALLBACK_PREFIX.slice(0, room).replace(/-+$/, "") || "a";
  return `${base.length > 0 ? base : fallback}${suffix}`;
}

