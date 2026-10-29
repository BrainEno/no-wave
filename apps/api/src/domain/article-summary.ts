/**
 * Automatic article summaries.
 *
 * Authors may leave the summary field empty; the excerpt is then derived from
 * the beginning of the body text. The cut is sentence-aware: text is split with
 * `Intl.Segmenter` (sentence granularity), whole sentences are kept while they
 * fit, and only when a single sentence is longer than the budget is it cut —
 * at a word boundary, so `Intl.Segmenter` word granularity keeps Latin words
 * whole and ICU's dictionary keeps Chinese words whole.
 *
 * Two rules are invariants of the output:
 *  - a summary never ends on punctuation that cannot end a sentence (，、；：and
 *    friends are stripped before the ellipsis is added);
 *  - `…` is only ever appended when the text was actually cut, and never
 *    directly after another punctuation mark.
 */
export const ARTICLE_SUMMARY_MAX_LENGTH = 110;
const ELLIPSIS = "…";
const SENTENCE_TERMINATORS = /[。．.！!？?…‼⁇⁈⁉]$/u;
const TRAILING_PUNCTUATION = /[\p{P}\p{S}\s]+$/u;
const LATIN_EDGE = /[A-Za-z0-9]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Code points, not UTF-16 units: a summary must never split a surrogate pair. */
function characters(value: string): string[] {
  return [...value];
}

/** Collapse runs of whitespace but keep line breaks as paragraph boundaries. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, (run) => (run.includes("\n") ? "\n" : " ")).trim();
}

/** Join neighbours: a space only between Latin words, never inside Chinese. */
function glueFor(before: string, after: string): string {
  if (before.length === 0 || after.length === 0) return "";
  return LATIN_EDGE.test(before[before.length - 1]) && LATIN_EDGE.test(after[0]) ? " " : "";
}

function flatten(value: string): string {
  return value.replace(/\n+/g, (run, offset: number, whole: string) =>
    glueFor(whole.slice(0, offset), whole.slice(offset + run.length)));
}

function segmentSentences(value: string, locale: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    try {
      return [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(value)]
        .map((item) => item.segment)
        .map((segment) => flatten(segment).trim())
        .filter((segment) => segment.length > 0);
    } catch {
      // Unknown locale: treat the whole text as one sentence below.
    }
  }
  return [flatten(value).trim()].filter((segment) => segment.length > 0);
}

/** Cut at the last word boundary that fits; hard-cut only if a single word overflows. */
function cutAtWordBoundary(value: string, maxLength: number, locale: string): string {
  const chars = characters(value);
  if (typeof Intl.Segmenter === "function") {
    try {
      let consumed = 0;
      let boundary = 0;
      for (const { segment } of new Intl.Segmenter(locale, { granularity: "word" }).segment(value)) {
        const size = characters(segment).length;
        if (consumed + size > maxLength) break;
        consumed += size;
        if (segment.trim().length > 0) boundary = consumed;
      }
      if (boundary > 0) return chars.slice(0, boundary).join("");
    } catch {
      // Fall through to the hard cut.
    }
  }
  return chars.slice(0, maxLength).join("");
}

/**
 * A cut summary: strip punctuation that cannot end a sentence, then add `…`
 * only when the text does not already end on a sentence terminator. `…`
 * therefore never follows another punctuation mark.
 */
function closeSummary(value: string): string {
  const trimmed = value.replace(/\s+$/, "");
  // A sentence that was kept whole already ends on a terminator; it needs no
  // ellipsis, and the terminator must survive.
  if (SENTENCE_TERMINATORS.test(trimmed)) return trimmed;
  const stripped = trimmed.replace(TRAILING_PUNCTUATION, "");
  if (stripped.length === 0) return `${trimmed}${ELLIPSIS}`;
  return `${stripped}${ELLIPSIS}`;
}

function blockText(block: unknown): string {
  if (!isRecord(block)) return "";
  const type = block.type;
  if (type === "paragraph" || type === "heading" || type === "quote") {
    return typeof block.text === "string" ? block.text : "";
  }
  if (type === "list" && Array.isArray(block.items)) {
    return block.items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("，");
  }
  // Code blocks and images carry no prose for an excerpt.
  return "";
}

/** Build the excerpt of a validated (or freshly converted) article document. */
export function summarizeArticleBlocks(
  blocks: unknown,
  { maxLength = ARTICLE_SUMMARY_MAX_LENGTH, locale = "zh-CN" }: { maxLength?: number; locale?: string } = {},
): string {
  const list = Array.isArray(blocks) ? blocks : [];
  const text = list.map(blockText).filter((value) => value.trim().length > 0).join("\n");
  return summarizeArticleText(text, { maxLength, locale });
}

/** Build the excerpt of already-flattened prose. Exported for tests and reuse. */
export function summarizeArticleText(
  text: unknown,
  { maxLength = ARTICLE_SUMMARY_MAX_LENGTH, locale = "zh-CN" }: { maxLength?: number; locale?: string } = {},
): string {
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : ARTICLE_SUMMARY_MAX_LENGTH;
  const source = normalizeWhitespace(typeof text === "string" ? text : "");
  if (source.length === 0) return "";
  if (characters(source).length <= limit) return flatten(source);

  const sentences = segmentSentences(source, locale);
  let result = "";
  let cut = false;
  for (const sentence of sentences) {
    if (result.length === 0) {
      if (characters(sentence).length > limit) {
        result = cutAtWordBoundary(sentence, limit, locale);
        cut = true;
        break;
      }
      result = sentence;
      continue;
    }
    const glue = glueFor(result, sentence);
    if (characters(result).length + characters(glue).length + characters(sentence).length > limit) {
      cut = true;
      break;
    }
    result = `${result}${glue}${sentence}`;
  }
  return cut ? closeSummary(result) : result;
}
