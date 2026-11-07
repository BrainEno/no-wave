import { decodeCursor, encodeCursor } from "./cursor.ts";
import { ArticleInputError } from "./errors.ts";
import { isUuid, requiredText } from "./validation.ts";

const SUPPORTED_ARTICLE_LOCALES = new Set(["zh-CN", "zh-TW", "en"]);
const ARTICLE_WORK_TYPES = new Set(["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"]);
const ARTICLE_BLOCK_TYPES = new Set(["paragraph", "heading", "quote", "list", "image", "code"]);
const ARTICLE_CONTENT_BLOCK_VERSIONS = new Set([0, 1]);
const INLINE_MARKS = new Set(["bold", "italic", "underline", "strikethrough", "code"]);
const MAX_DOCUMENT_JSON_CHARACTERS = 1_000_000;
const MAX_INLINE_RUNS_PER_BLOCK = 1_000;
export const supportedArticleWorkTypes = Object.freeze([...ARTICLE_WORK_TYPES]);

export { SUPPORTED_ARTICLE_LOCALES };

export function validateArticleWorkType(value: unknown): string {
  if (typeof value !== "string" || !ARTICLE_WORK_TYPES.has(value)) {
    throw new ArticleInputError("workType must be one of the supported literary work types.");
  }
  return value;
}

/**
 * Work types that can still exist but can no longer be chosen.
 *
 * `serial` (连载) was retired for new work by ADR 0016 / `38d087b` — the platform
 * publishes short and medium-form writing, and a serialised work needs chapter
 * state the product does not model. Deleting the type outright is not an option:
 * works created before that decision still have to be listed, read and edited, so
 * removing it would either orphan them or silently retype real content on the next
 * save.
 *
 * The rule is therefore "cannot be chosen, can still exist". The authoring desk
 * stopped offering it (#196); this is the same rule on the write contract, where
 * a client that bypasses the desk can still reach it.
 */
const RETIRED_ARTICLE_WORK_TYPES = new Set(["serial"]);
export const retiredArticleWorkTypes = Object.freeze([...RETIRED_ARTICLE_WORK_TYPES]);

/**
 * A type a new work may be created with.
 *
 * Called on create only: a stored `serial` work must stay saveable, or the author
 * loses the ability to fix a typo in work the platform itself accepted.
 */
export function assertCreatableArticleWorkType(value: unknown): string {
  const workType = validateArticleWorkType(value);
  if (RETIRED_ARTICLE_WORK_TYPES.has(workType)) {
    throw new ArticleInputError("workType \"serial\" is retired: a new work must use an active literary work type.");
  }
  return workType;
}

/**
 * A type change on an existing work.
 *
 * Unchanged is always allowed, including a legacy type keeping itself, so an
 * ordinary edit of an old serial work is not rejected for the type it already
 * has. Anything else has to be creatable — which also means an author may retype
 * a legacy serial work to a supported type, the one direction that removes the
 * legacy value.
 */
export function assertArticleWorkTypeChange(previousWorkType: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const workType = validateArticleWorkType(value);
  if (workType !== previousWorkType && RETIRED_ARTICLE_WORK_TYPES.has(workType)) {
    throw new ArticleInputError("workType \"serial\" is retired: an existing work cannot be retyped to it.");
  }
  return workType;
}

export function validateArticleSlug(value: unknown): string {
  const slug = requiredText("slug", value, 160);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new ArticleInputError("slug must contain lowercase ASCII letters, digits, and single hyphens.");
  }
  return slug;
}

export function validateArticleLocale(value: unknown): string {
  if (typeof value !== "string" || !SUPPORTED_ARTICLE_LOCALES.has(value)) {
    throw new ArticleInputError("locale must be zh-CN, zh-TW or en.");
  }
  return value;
}

export function validateArticleContentBlocksVersion(value: unknown): number {
  const version = value === undefined ? 0 : value;
  if (typeof version !== "number" || !Number.isInteger(version) || !ARTICLE_CONTENT_BLOCK_VERSIONS.has(version)) {
    throw new ArticleInputError("contentBlocksVersion must be 0 or 1.");
  }
  return version;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value: Record<string, unknown>, allowedFields: ReadonlySet<string>, name: string): void {
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new ArticleInputError(`${name} contains unsupported fields.`);
  }
}

function validateDocumentUrl(name: string, value: unknown): string {
  const urlValue = requiredText(name, value, 2048);
  if (/[\u0000-\u0020\u007f\\]/.test(urlValue)) {
    throw new ArticleInputError(`${name} must not contain whitespace, control characters, or backslashes.`);
  }
  if (urlValue.startsWith("/") && !urlValue.startsWith("//")) return urlValue;

  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new ArticleInputError(`${name} must be a site-relative path or a valid HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ArticleInputError(`${name} must be a site-relative path or a valid HTTP(S) URL without credentials.`);
  }
  return urlValue;
}

function validateInlineRuns(runs: unknown, expectedText: string, name: string): void {
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > MAX_INLINE_RUNS_PER_BLOCK) {
    throw new ArticleInputError(`${name} must contain between 1 and ${MAX_INLINE_RUNS_PER_BLOCK} inline runs.`);
  }
  let combinedText = "";
  for (let index = 0; index < runs.length; index += 1) {
    const run: unknown = runs[index];
    const runName = `${name}[${index}]`;
    if (!isRecord(run)) throw new ArticleInputError(`${runName} must be an object.`);
    rejectUnknownFields(run, new Set(["text", "marks", "href"]), runName);
    if (typeof run.text !== "string" || run.text.length < 1 || run.text.length > 20_000) {
      throw new ArticleInputError(`${runName}.text must be a non-empty string no longer than 20000 characters.`);
    }
    if (run.marks !== undefined &&
        (!Array.isArray(run.marks) || run.marks.length > INLINE_MARKS.size ||
         !run.marks.every((mark: unknown) => typeof mark === "string" && INLINE_MARKS.has(mark)) ||
         new Set(run.marks).size !== run.marks.length)) {
      throw new ArticleInputError(`${runName}.marks must contain unique supported inline marks.`);
    }
    if (run.href !== undefined) validateDocumentUrl(`${runName}.href`, run.href);
    combinedText += run.text;
  }
  if (combinedText !== expectedText) {
    throw new ArticleInputError(`${name} text must exactly match the block's plain-text fallback.`);
  }
}

const BLOCK_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  paragraph: new Set(["id", "type", "text", "inlines"]),
  heading: new Set(["id", "type", "text", "level", "inlines"]),
  quote: new Set(["id", "type", "text", "attribution", "inlines"]),
  list: new Set(["id", "type", "ordered", "items", "itemInlines"]),
  image: new Set(["id", "type", "src", "alt", "caption"]),
  code: new Set(["id", "type", "language", "code"]),
};

export function validateArticleBlocks(blocks: unknown, contentBlocksVersion: unknown = 0): Record<string, unknown>[] {
  const version = validateArticleContentBlocksVersion(contentBlocksVersion);
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 200) {
    throw new ArticleInputError("contentBlocks must be an array containing between 1 and 200 blocks.");
  }
  if (JSON.stringify(blocks).length > MAX_DOCUMENT_JSON_CHARACTERS) {
    throw new ArticleInputError("contentBlocks must not exceed 1000000 serialized characters.");
  }

  const seenIds = new Set<string>();
  // `Array.isArray` narrows `unknown` to `any[]`; naming it `unknown[]` keeps the
  // element type honest, so every field below has to be validated to be read.
  const parsedBlocks: unknown[] = blocks;
  return parsedBlocks.map((block, index) => {
    const name = `contentBlocks[${index}]`;
    if (!isRecord(block)) throw new ArticleInputError(`${name} must be an object.`);
    if (typeof block.type !== "string" || !ARTICLE_BLOCK_TYPES.has(block.type)) {
      throw new ArticleInputError(`${name}.type is unsupported.`);
    }
    rejectUnknownFields(block, BLOCK_FIELDS[block.type]!, name);
    if (version === 0 && ("inlines" in block || "itemInlines" in block)) {
      throw new ArticleInputError("Inline formatting and links require contentBlocksVersion 1.");
    }

    const id = requiredText(`${name}.id`, block.id, 100);
    if (seenIds.has(id)) throw new ArticleInputError("content block IDs must be unique within an article.");
    seenIds.add(id);

    if (block.type === "paragraph" || block.type === "heading" || block.type === "quote") {
      const text = requiredText(`${name}.text`, block.text, 20_000);
      if (block.type === "heading" && (typeof block.level !== "number" || !Number.isInteger(block.level) || block.level < 2 || block.level > 4)) {
        throw new ArticleInputError("heading level must be an integer between 2 and 4.");
      }
      if (block.type === "quote" && block.attribution !== undefined &&
          (typeof block.attribution !== "string" || block.attribution.length > 300)) {
        throw new ArticleInputError("quote attribution must be a string no longer than 300 characters.");
      }
      if (block.inlines !== undefined) {
        if (version !== 1) throw new ArticleInputError("Inline formatting and links require contentBlocksVersion 1.");
        validateInlineRuns(block.inlines, text, `${name}.inlines`);
      }
    } else if (block.type === "list") {
      const items = block.items;
      const itemInlines = block.itemInlines;
      if (typeof block.ordered !== "boolean" || !Array.isArray(items) || items.length < 1 || items.length > 100 ||
          !items.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 2000)) {
        throw new ArticleInputError("list blocks require an ordered flag and 1 to 100 non-empty text items.");
      }
      // Every item passed the predicate above, so this keeps all of them and
      // gives the loop below the string element type the predicate proved.
      const itemTexts = items.filter((item): item is string => typeof item === "string");
      if (itemInlines !== undefined) {
        if (version !== 1 || !Array.isArray(itemInlines) || itemInlines.length !== itemTexts.length) {
          throw new ArticleInputError("itemInlines requires version 1 and exactly one inline-run array per list item.");
        }
        itemInlines.forEach((runs, itemIndex) =>
          validateInlineRuns(runs, itemTexts[itemIndex]!, `${name}.itemInlines[${itemIndex}]`));
      }
    } else if (block.type === "image") {
      const src = requiredText(`${name}.src`, block.src, 2048);
      validateDocumentUrl(`${name}.src`, src);
      if (typeof block.alt !== "string" || block.alt.length > 1000) {
        throw new ArticleInputError("image alt must be a string no longer than 1000 characters.");
      }
      if (block.caption !== undefined && (typeof block.caption !== "string" || block.caption.length > 1000)) {
        throw new ArticleInputError("image caption must be a string no longer than 1000 characters.");
      }
    } else if (block.type === "code") {
      requiredText(`${name}.language`, block.language, 50);
      if (typeof block.code !== "string" || block.code.length > 50_000) {
        throw new ArticleInputError("code blocks must contain at most 50000 characters.");
      }
    }
    return block;
  });
}

export type ArticleNormalizeInput = {
  slug: unknown;
  title: unknown;
  summary?: unknown;
  locale: unknown;
  contentBlocks: unknown;
  contentBlocksVersion?: unknown;
  publish?: unknown;
  workType?: unknown;
};

export function normalizeArticleInput({ slug, title, summary, locale, contentBlocks, contentBlocksVersion, publish, workType }: ArticleNormalizeInput) {
  const version = validateArticleContentBlocksVersion(contentBlocksVersion);
  return {
    slug: validateArticleSlug(slug),
    title: requiredText("title", title, 250),
    summary: summary === undefined ? "" : (typeof summary === "string" && summary.length <= 2000 ? summary : (() => { throw new ArticleInputError("summary must be a string no longer than 2000 characters."); })()),
    locale: validateArticleLocale(locale),
    workType: workType === undefined ? undefined : validateArticleWorkType(workType),
    contentBlocksVersion: version,
    contentBlocks: validateArticleBlocks(contentBlocks, version),
    publish: publish === true,
  };
}

/**
 * How many works the featured shelf holds. * How many works the featured shelf holds.
 *
 * A shelf of a hundred is a list of everything, and the whole point of a curated
 * shelf is that somebody chose. Twenty is enough for a real front page and small
 * enough that "the editors picked these" still means something — and because the
 * write replaces the whole shelf, it also bounds one request.
 */
export const MAX_FEATURED_ARTICLES = 20;

/**
 * How deep a reader may page through the public article lists by `offset`.
 *
 * Two ceilings, because the two orders can offer different things past a point.
 *
 * `sort=latest` walks the newest-first order, which a cursor names exactly — the
 * keyset `(published_at, id)` — so a deep page is supported and 100 000 is only a
 * sanity bound on an `OFFSET` the database still has to count.
 *
 * `sort=popular` cannot have a cursor: the count it orders by changes while the
 * reader is reading, so a page boundary drawn through it drifts — they meet a
 * work twice after it is saved, and never meet one that was saved past them
 * (ADR 0006's list contract, and the same reasoning the store states). What that
 * order has instead is a bound: past 10 000 the answer is not "another page", it
 * is "this list is not a place to read that far", and the route says so instead
 * of running a scan whose result would be wrong by the time it returned.
 */
export const MAX_ARTICLE_OFFSET = 100_000;

export const MAX_ARTICLE_OFFSET_POPULAR = 10_000;

/** The offset ceiling that applies to a list read in this order. */
export function maxArticleOffset(sort: "latest" | "popular"): number {
  return sort === "popular" ? MAX_ARTICLE_OFFSET_POPULAR : MAX_ARTICLE_OFFSET;
}

/**
 * The refusal for a page deeper than the order allows, or `null` if it is not
 * that case.
 */
export function describeArticleOffsetLimit(sort: "latest" | "popular", requested: number): string | null {
  if (sort === "latest" || !Number.isSafeInteger(requested) || requested <= MAX_ARTICLE_OFFSET_POPULAR) return null;
  return `offset is limited to ${MAX_ARTICLE_OFFSET_POPULAR} with sort=popular: the most-saved order is re-ranked while it is read, so it has no cursor to fall back on. Page deeper with sort=latest and a cursor.`;
}

/**
 * The refusal for a cursor in an order that has none, or `null`.
 *
 * `sort=popular` counts saves, and a save can land while the reader is paging:
 * the row a cursor names may have moved, so the token cannot mean "resume here".
 * `latest` is published-at order, which only grows at the top. The transport asks
 * this before the store does, so the answer is a `400` with a reason rather than
 * an exception from inside a query — the same reason the offset ceiling is
 * checked there.
 */
export function describeArticleCursorOrder(sort: "latest" | "popular"): string | null {
  if (sort === "latest") return null;
  return `cursor is only supported with sort=latest: the most-saved order is re-ranked while it is read, so it has no stable place to resume from. Page with an offset up to ${MAX_ARTICLE_OFFSET_POPULAR}, or use sort=latest with a cursor.`;
}

/** Whichever of the two page refusals applies to this request, or `null`. */
export function describeArticlePageRefusal(args: {
  sort: "latest" | "popular";
  /** Whether the request named a cursor at all — that is what makes the first one apply. */
  hasCursor: boolean;
  offset: number;
}): string | null {
  if (args.hasCursor) return describeArticleCursorOrder(args.sort);
  return describeArticleOffsetLimit(args.sort, args.offset);
}

/**
 * The cursor pointing *past* `publishedAt`/`id` in the newest-first order.
 *
 * The encoding is shared with every other newest-first list (ADR 0022); what is
 * work-specific here is only the name of the timestamp half.
 */
export function encodeArticleCursor(publishedAt: string, id: string): string {
  return encodeCursor(publishedAt, id);
}

/** The place a cursor names, or `null` if it names nothing we recognise. */
export function decodeArticleCursor(cursor: string): { publishedAt: string; id: string } | null {
  const decoded = decodeCursor(cursor);
  return decoded ? { publishedAt: decoded.at, id: decoded.id } : null;
}

/**
 * What a cursor means for one list read, shared by both adapters.
 *
 * It lives here rather than in each store because the rules are rules, not SQL:
 * a cursor walks the newest-first order only, and it is not to be combined with
 * an offset. Two copies of "only with sort=latest" would eventually disagree.
 */
export function resolveArticleCursor(args: { cursor: unknown; sort: string; offset: number }): { publishedAt: string; id: string } | null {
  const { cursor, sort, offset } = args;
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.trim().length === 0 || cursor !== cursor.trim()) {
    throw new ArticleInputError("cursor must be a non-empty, trimmed string.");
  }
  if (sort !== "latest") {
    throw new ArticleInputError("A cursor is only supported with sort=latest; the most-saved order is re-ranked while it is being read.");
  }
  // Two different answers to "where does this page start" — accepting both would
  // mean silently deciding which one wins.
  if (offset > 0) throw new ArticleInputError("Pass either offset or cursor, not both.");
  const decoded = decodeArticleCursor(cursor);
  if (!decoded) throw new ArticleInputError("Invalid cursor.");
  return decoded;
}

export function normalizeTaxonomyIds(name: string, ids: unknown, max: number): string[] | undefined {
  if (ids === undefined || ids === null) return undefined;
  if (!Array.isArray(ids) || ids.length > max) {
    throw new ArticleInputError(`${name} must contain at most ${max} valid UUIDs.`);
  }
  // `isUuid` is a type predicate, so the filter is the narrowing: a rejected id
  // simply does not survive it, and the length check below is the rejection.
  const normalized = ids.filter(isUuid);
  if (normalized.length !== ids.length) {
    throw new ArticleInputError(`${name} must contain at most ${max} valid UUIDs.`);
  }
  if (new Set(normalized).size !== normalized.length) throw new ArticleInputError(`${name} cannot contain duplicate IDs.`);
  return normalized;
}
