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
