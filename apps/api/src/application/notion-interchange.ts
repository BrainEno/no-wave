/**
 * Notion as an interchange format, not a dependency.
 *
 * The site's article model and a Notion database are close enough that a work
 * can move between them without a lossy "sync engine": a work is a title, a
 * summary, an ordered list of blocks, a locale, a tag set, a publish flag and a
 * date. A Notion database row is the same list of facts wearing different
 * property names.
 *
 * This module is the whole mapping, and it is deliberately *pure*: no HTTP, no
 * database, no credentials, no clock beyond an injected `now`. That keeps the
 * one thing both directions must agree on in one reviewable file, lets the
 * import path and the export path be tested against each other, and means an
 * import run can be replayed in a test with the exact payload Notion returned.
 *
 * Two consequences are worth stating up front, because they shape the type
 * signatures:
 *
 * 1. **A block can be dropped but text never is.** The site's block model is
 *    small (paragraph, heading, quote, list, image, code). Notion is larger
 *    (callouts, toggles, tables, bookmarks, equations, child pages). Anything
 *    without an equivalent is *flattened into the nearest thing that can hold
 *    its text* — a bookmark becomes a paragraph holding its link, an equation a
 *    paragraph in code marks — and anything whose text genuinely cannot be
 *    carried (a table's cell grid, a child page) is dropped **with a recorded
 *    issue**. Silent loss is the one outcome this module refuses.
 * 2. **Notion file URLs expire.** A `files` property or image block of type
 *    `file` carries a signed S3 URL valid for about an hour. Storing it would
 *    publish a broken image tomorrow, so the mapping reports
 *    `expiring-image-url` and the caller is expected to copy the bytes into the
 *    site's own storage before the URL dies.
 */
import { slugifyArticleTitle } from "../domain/article-slug.ts";
import { validateArticleBlocks } from "../domain/article.ts";

/** Bumped when a stored draft changes shape; import runs record the version. */
export const NOTION_INTERCHANGE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Notion payload shapes (the subset this mapping reads)                       */
/* -------------------------------------------------------------------------- */

export type NotionAnnotations = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string;
};

export type NotionRichText = {
  type?: string;
  plain_text?: string;
  href?: string | null;
  text?: { content?: string; link?: { url?: string } | null } | null;
  equation?: { expression?: string } | null;
  annotations?: NotionAnnotations;
};

export type NotionFile = {
  name?: string;
  type?: string;
  file?: { url?: string; expiry_time?: string } | null;
  external?: { url?: string } | null;
};

export type NotionBlockLike = {
  id?: string;
  type?: string;
  has_children?: boolean;
} & Record<string, unknown>;

export type NotionPropertyValue = {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  date?: { start?: string | null; end?: string | null } | null;
  checkbox?: boolean;
  multi_select?: { name?: string }[];
  files?: NotionFile[];
  number?: number | null;
  relation?: { id?: string }[];
  select?: { name?: string } | null;
};

export type NotionPageLike = {
  id?: string;
  properties?: Record<string, NotionPropertyValue>;
};

/* -------------------------------------------------------------------------- */
/* Issues                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every reason a page or block could not be carried over verbatim.
 *
 * Codes are stable strings rather than prose because the report is data: the
 * authoring desk counts them, the import result groups by them, and a test can
 * assert that a real payload produces exactly the set it should.
 */
export const INTERCHANGE_ISSUE_CODES = Object.freeze([
  "empty-block-dropped",
  "unsupported-block",
  "block-limit-reached",
  "expiring-image-url",
  "image-copy-failed",
  "link-block-flattened",
  "equation-flattened",
  "callout-flattened",
  "toggle-flattened",
  "checkbox-state-dropped",
  "table-block-dropped",
  "invalid-block-dropped",
  "empty-body",
  "empty-title",
  "slug-derived",
  "work-type-fallback",
  "featured-image-not-carried",
  "hierarchy-not-carried",
  /**
   * Export-side: a property of the work that has no Notion property to live in,
   * so a round trip comes back different. Reported rather than dropped, because
   * the author is about to hand this bundle to their own database.
   */
  "work-type-not-carried",
  /** Export-side: an edition in a language the Notion mapping has no page for. */
  "translation-locale-not-carried",
] as const);

/** Derived from the list so the published contract and the code cannot drift. */
export type InterchangeIssueCode = (typeof INTERCHANGE_ISSUE_CODES)[number];

export type InterchangeIssue = { code: InterchangeIssueCode; detail: string };

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Property names are options, not constants: the next author's database is not
 * this one. Only the *title* property is found by type, because every Notion
 * database has exactly one and its name is arbitrary.
 */
export type NotionPropertyNames = {
  slug: string;
  summary: string;
  date: string;
  published: string;
  tags: string;
  featuredImage: string;
};

export const DEFAULT_NOTION_PROPERTY_NAMES: NotionPropertyNames = Object.freeze({
  slug: "Slug",
  summary: "Excerpt",
  date: "Date",
  published: "Published",
  tags: "Tags",
  featuredImage: "FeaturedImage",
});

/**
 * The tag vocabulary this site's own database already uses, mapped onto the
 * work types the write contract accepts. A tag that is not in the table leaves
 * the work `other` — a wrong genre is worse than an unspecific one, and the
 * author can retype it in one click.
 */
export const DEFAULT_WORK_TYPE_BY_TAG: Readonly<Record<string, string>> = Object.freeze({
  小说: "novel",
  短篇: "short_story",
  诗歌: "poetry",
  诗: "poetry",
  散文: "essay",
  评论: "criticism",
  文学批评: "literary_criticism",
  非虚构: "nonfiction",
  其他: "other",
});

export type NotionImportOptions = {
  /** The edition this page *is*; a linked English page is imported as `en`. */
  locale?: string;
  propertyNames?: Partial<NotionPropertyNames>;
  workTypeByTag?: Readonly<Record<string, string>>;
  defaultWorkType?: string;
  /** Overrides the `Published` checkbox when present. */
  publish?: boolean;
  /** The clock used when a published page has no `Date`. */
  now?: () => Date;
};

export type NotionExportOptions = {
  propertyNames?: Partial<NotionPropertyNames>;
  /** Page title of the parent database entry, used for `Title` only. */
  slug?: string;
};

/* -------------------------------------------------------------------------- */
/* Article-shaped output                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One article *edition* ready for the write contract, before the caller assigns
 * a work id or resolves slug uniqueness.
 *
 * `slug` is a suggestion: the sites's address is work-level and globally
 * unique, so an importer takes the slug of the page it treats as the work's
 * primary edition and lets the store disambiguate. It is still derived here so
 * a single-page import needs no second decision.
 */
export type NotionArticleDraft = {
  externalId: string;
  slug: string;
  locale: string;
  title: string;
  summary: string;
  workType: string;
  tags: string[];
  publish: boolean;
  /** UTC instant; `null` when the work is unpublished and undated. */
  publishedAt: string | null;
  contentBlocksVersion: 1;
  contentBlocks: Record<string, unknown>[];
};

export type NotionImportResult =
  | { draft: NotionArticleDraft; issues: InterchangeIssue[] }
  | { draft: null; issues: InterchangeIssue[] };

/* -------------------------------------------------------------------------- */
/* Reading Notion values                                                      */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRichText(value: unknown): NotionRichText[] {
  return Array.isArray(value) ? (value as NotionRichText[]) : [];
}

/** The visible text of a rich-text array, as Notion itself renders it. */
export function notionPlainText(items: readonly NotionRichText[]): string {
  return items.map((item) => (typeof item.plain_text === "string" ? item.plain_text : "")).join("");
}

function marksOf(annotations: NotionAnnotations | undefined): string[] {
  if (!annotations) return [];
  const marks: string[] = [];
  if (annotations.bold) marks.push("bold");
  if (annotations.italic) marks.push("italic");
  if (annotations.underline) marks.push("underline");
  if (annotations.strikethrough) marks.push("strikethrough");
  if (annotations.code) marks.push("code");
  return marks;
}

/**
 * Rich text to the site's inline runs.
 *
 * Built from `plain_text` rather than `text.content` on purpose: the write
 * contract requires the concatenated runs to equal the block's `text` *exactly*
 * (see `validateInlineRuns`), and `plain_text` is the string Notion shows for
 * every rich-text kind — text, mention, equation, link preview. Using it for
 * both sides makes the equality structural instead of a coincidence.
 */
export function notionInlines(items: readonly NotionRichText[]): { text: string; inlines: { text: string; marks?: string[]; href?: string }[] } | null {
  const inlines: { text: string; marks?: string[]; href?: string }[] = [];
  for (const item of items) {
    const text = typeof item.plain_text === "string" ? item.plain_text : "";
    if (text.length === 0) continue;
    const run: { text: string; marks?: string[]; href?: string } = { text };
    const marks = marksOf(item.annotations);
    if (marks.length > 0) run.marks = marks;
    if (typeof item.href === "string" && item.href.length > 0) run.href = item.href;
    inlines.push(run);
  }
  if (inlines.length === 0) return null;
  return { text: inlines.map((run) => run.text).join(""), inlines };
}

/** A URL the site's block validator will accept, or `null`. */
function documentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function fileUrl(file: NotionFile | undefined): { url: string | null; expiring: boolean } {
  if (!file) return { url: null, expiring: false };
  const signed = documentUrl(file.file?.url);
  if (signed) return { url: signed, expiring: true };
  return { url: documentUrl(file.external?.url), expiring: false };
}

/* -------------------------------------------------------------------------- */
/* Notion blocks -> article blocks                                            */
/* -------------------------------------------------------------------------- */

const EMPTY_BLOCK = Symbol("empty");

type Conversion = Record<string, unknown> | typeof EMPTY_BLOCK;

function textBlock(type: "paragraph" | "heading" | "quote", richText: readonly NotionRichText[], extra: Record<string, unknown> = {}): Conversion {
  const converted = notionInlines(richText);
  if (converted === null) return EMPTY_BLOCK;
  return { type, text: converted.text, inlines: converted.inlines, ...extra };
}

function codeLanguage(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw.replace(/[^a-z0-9+#-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 50) : "text";
}

/**
 * Convert a Notion block tree into article blocks.
 *
 * Consecutive list items are merged into the site's `list` blocks (the site
 * stores a list, Notion stores rows), and every container block's children are
 * appended after it — the site's model is flat, so a callout's children become
 * the paragraphs that follow it. `has_children` is *not* trusted for the choice
 * of container behaviour: only the block's own type decides, and the caller
 * passes the flattened child list.
 */
export function notionBlocksToArticleBlocks(
  blocks: readonly NotionBlockLike[],
  { maxBlocks = 200 }: { maxBlocks?: number } = {},
): { blocks: Record<string, unknown>[]; issues: InterchangeIssue[] } {
  const issues: InterchangeIssue[] = [];
  const out: Record<string, unknown>[] = [];
  let pending: string[] = [];
  let pendingOrdered = false;
  let pendingInlines: { text: string; marks?: string[]; href?: string }[][] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    // The site caps a list at 100 items, so a longer Notion list becomes
    // several lists rather than being truncated.
    while (pending.length > 0) {
      const items = pending.slice(0, 100);
      const itemInlines = pendingInlines.slice(0, 100);
      pending = pending.slice(items.length);
      pendingInlines = pendingInlines.slice(itemInlines.length);
      const block: Record<string, unknown> = { type: "list", ordered: pendingOrdered, items, itemInlines };
      block.id = `list-${out.length + 1}`;
      out.push(block);
    }
  };

  const push = (block: Record<string, unknown>): void => {
    block.id = `block-${out.length + 1}`;
    out.push(block);
  };

  for (const block of blocks) {
    const type = typeof block.type === "string" ? block.type : "";
    const data = asRecord(block[type]);

    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      const ordered = type === "numbered_list_item";
      const converted = notionInlines(asRichText(data.rich_text));
      if (converted === null) {
        issues.push({ code: "empty-block-dropped", detail: `${type} without text` });
        continue;
      }
      // A list whose kind flips is two lists, not one.
      if (pending.length > 0 && ordered !== pendingOrdered) flush();
      pendingOrdered = ordered;
      pending.push(converted.text);
      pendingInlines.push(converted.inlines);
      continue;
    }
    flush();

    if (type === "paragraph") {
      const converted = textBlock("paragraph", asRichText(data.rich_text));
      if (converted === EMPTY_BLOCK) issues.push({ code: "empty-block-dropped", detail: "paragraph without text" });
      else push(converted);
      continue;
    }
    if (type === "heading_1" || type === "heading_2" || type === "heading_3") {
      // The site's headings are 2..4 — a document cannot carry its own H1,
      // because the page title is the H1. Notion's H1 therefore lands on 2.
      const level = type === "heading_1" ? 2 : type === "heading_2" ? 3 : 4;
      const converted = textBlock("heading", asRichText(data.rich_text), { level });
      if (converted === EMPTY_BLOCK) issues.push({ code: "empty-block-dropped", detail: `${type} without text` });
      else push(converted);
      continue;
    }
    if (type === "quote") {
      const converted = textBlock("quote", asRichText(data.rich_text));
      if (converted === EMPTY_BLOCK) issues.push({ code: "empty-block-dropped", detail: "quote without text" });
      else push(converted);
      continue;
    }
    if (type === "code") {
      const code = notionPlainText(asRichText(data.rich_text));
      if (code.length === 0) {
        issues.push({ code: "empty-block-dropped", detail: "code block without text" });
      } else {
        push({ type: "code", language: codeLanguage(data.language), code: code.slice(0, 50_000) });
      }
      continue;
    }
    if (type === "image") {
      // Notion's own file/pick: `{type: "file", file: {url, expiry_time}}` for an
      // uploaded image, `{type: "external", external: {url}}` for a linked one.
      const hosted = (typeof data.type === "string" ? data.type : "file") !== "external";
      const source: NotionFile = hosted
        ? { type: "file", file: asRecord(data.file) as { url?: string; expiry_time?: string } }
        : { type: "external", external: asRecord(data.external) as { url?: string } };
      const { url, expiring } = fileUrl(source);
      const caption = notionPlainText(asRichText(data.caption));
      if (url === null) {
        issues.push({ code: "unsupported-block", detail: "image without a usable URL" });
      } else {
        if (expiring) issues.push({ code: "expiring-image-url", detail: url });
        push({ type: "image", src: url, alt: caption, ...(caption.length > 0 ? { caption } : {}) });
      }
      continue;
    }
    if (type === "bookmark" || type === "embed" || type === "video" || type === "audio" || type === "file" || type === "pdf") {
      // No block type can host these, but a paragraph with a linked run keeps
      // the reference readable and clickable instead of erasing it.
      const raw = type === "bookmark" || type === "embed" ? data.url : (asRecord(data.file ?? data.external).url ?? data.url);
      const url = documentUrl(raw);
      if (url === null) {
        issues.push({ code: "unsupported-block", detail: `${type} without a usable URL` });
      } else {
        issues.push({ code: "link-block-flattened", detail: `${type} -> paragraph` });
        push({ type: "paragraph", text: url, inlines: [{ text: url, href: url }] });
      }
      continue;
    }
    if (type === "equation") {
      const expression = typeof data.expression === "string" ? data.expression : "";
      if (expression.length === 0) {
        issues.push({ code: "empty-block-dropped", detail: "equation without an expression" });
      } else {
        issues.push({ code: "equation-flattened", detail: expression });
        push({ type: "paragraph", text: expression, inlines: [{ text: expression, marks: ["code"] }] });
      }
      continue;
    }
    if (type === "callout" || type === "toggle") {
      const converted = notionInlines(asRichText(data.rich_text));
      if (converted === null) {
        issues.push({ code: "empty-block-dropped", detail: `${type} without text` });
      } else {
        issues.push({ code: type === "callout" ? "callout-flattened" : "toggle-flattened", detail: `${type} -> paragraph` });
        push({ type: "paragraph", text: converted.text, inlines: converted.inlines });
      }
      continue;
    }
    if (type === "to_do") {
      const converted = notionInlines(asRichText(data.rich_text));
      if (converted === null) {
        issues.push({ code: "empty-block-dropped", detail: "to_do without text" });
      } else {
        // A checkbox state has nowhere to live in a published work, and
        // prefixing the text with a glyph would edit the author's sentence.
        issues.push({ code: "checkbox-state-dropped", detail: data.checked === true ? "checked" : "unchecked" });
        push({ type: "paragraph", text: converted.text, inlines: converted.inlines });
      }
      continue;
    }
    if (type === "divider" || type === "column_list" || type === "column") {
      // Pure layout: nothing to carry, nothing lost.
      continue;
    }
    if (type === "table" || type === "table_row") {
      issues.push({ code: "table-block-dropped", detail: type });
      continue;
    }
    // child_page, child_database, link_to_page, table_of_contents,
    // breadcrumb, synced_block, unsupported_block, and anything newer than this
    // file. The text, if any, is not reachable here.
    issues.push({ code: "unsupported-block", detail: type.length > 0 ? type : "unknown" });

    if (out.length >= maxBlocks) {
      issues.push({ code: "block-limit-reached", detail: `stopped after ${maxBlocks} blocks` });
      break;
    }
  }
  flush();

  if (out.length > maxBlocks) {
    issues.push({ code: "block-limit-reached", detail: `kept the first ${maxBlocks} blocks` });
    out.length = maxBlocks;
  }

  // Last line of defence: a block the write contract would reject must never
  // leave this function, because the import endpoint would then fail the whole
  // page over one bad block. Validation is per block so the rest still lands.
  const valid: Record<string, unknown>[] = [];
  for (const block of out) {
    try {
      validateArticleBlocks([block], 1);
      valid.push(block);
    } catch (error) {
      issues.push({
        code: "invalid-block-dropped",
        detail: `${String(block.type)}: ${error instanceof Error ? error.message : "invalid"}`,
      });
    }
  }
  return { blocks: valid, issues };
}

/* -------------------------------------------------------------------------- */
/* Notion page -> article draft                                               */
/* -------------------------------------------------------------------------- */

function propertyOf(page: NotionPageLike, name: string): NotionPropertyValue | undefined {
  return page.properties?.[name];
}

function titleProperty(page: NotionPageLike): NotionPropertyValue | undefined {
  const properties = page.properties ?? {};
  for (const value of Object.values(properties)) {
    if (value?.type === "title") return value;
  }
  return undefined;
}

/**
 * A Notion date to the instant the site stores.
 *
 * `Date` is usually a calendar date (`2026-10-08`) with no zone, and the site
 * shows a date rather than a moment, so it is read as **UTC midnight of that
 * day** — the one reading that is the same number in every viewer's timezone
 * and therefore stable across an export and a re-import. A date that carries a
 * time and offset is honoured exactly; a date with a time but no zone is read
 * as UTC rather than as the server's local time, because the server's local
 * time is not a fact about the author.
 */
export function notionDateToInstant(value: { start?: string | null } | null | undefined): string | null {
  const start = value?.start;
  if (typeof start !== "string" || start.length === 0) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return `${start}T00:00:00.000Z`;
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(start);
  const parsed = new Date(zoned ? start : `${start}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * One page + its blocks -> one article edition.
 *
 * Returns `draft: null` when the page cannot be an article at all (no title, or
 * no body at all). An empty body is *not* invented into a placeholder: a
 * translation whose page is still blank is not a translation yet, and a work
 * with no body would fail the write contract for a reason the author can fix.
 */
export function articleDraftFromNotionPage(input: {
  page: NotionPageLike;
  blocks: readonly NotionBlockLike[];
  options?: NotionImportOptions;
}): NotionImportResult {
  const options = input.options ?? {};
  const names = { ...DEFAULT_NOTION_PROPERTY_NAMES, ...(options.propertyNames ?? {}) };
  const issues: InterchangeIssue[] = [];

  const title = notionPlainText(asRichText(titleProperty(input.page)?.title)).trim();
  if (title.length === 0) {
    issues.push({ code: "empty-title", detail: input.page.id ?? "unknown page" });
    return { draft: null, issues };
  }

  const converted = notionBlocksToArticleBlocks(input.blocks);
  issues.push(...converted.issues);
  if (converted.blocks.length === 0) {
    issues.push({ code: "empty-body", detail: title });
    return { draft: null, issues };
  }

  const summary = notionPlainText(asRichText(propertyOf(input.page, names.summary)?.rich_text)).trim();
  const declaredSlug = notionPlainText(asRichText(propertyOf(input.page, names.slug)?.rich_text)).trim();
  const locale = options.locale ?? "zh-CN";
  let slug: string;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(declaredSlug)) {
    slug = declaredSlug;
  } else {
    // The author's own database writes the *title* into `Slug` (「墙壁」), which
    // the site's ASCII-only address contract cannot hold. Transliterating the
    // title is the same rule the site already applies to hand-written work.
    slug = slugifyArticleTitle(title, { locale });
    issues.push({ code: "slug-derived", detail: `${declaredSlug || "(empty)"} -> ${slug}` });
  }

  const tags = (propertyOf(input.page, names.tags)?.multi_select ?? [])
    .map((tag) => (typeof tag?.name === "string" ? tag.name.trim() : ""))
    .filter((name) => name.length > 0);

  const workTypeByTag = options.workTypeByTag ?? DEFAULT_WORK_TYPE_BY_TAG;
  const derivedWorkType = tags.map((tag) => workTypeByTag[tag]).find((type): type is string => typeof type === "string");
  const workType = derivedWorkType ?? options.defaultWorkType ?? "other";
  if (derivedWorkType === undefined) {
    issues.push({ code: "work-type-fallback", detail: tags.length > 0 ? tags.join(",") : "(no tags)" });
  }

  const featured = propertyOf(input.page, names.featuredImage)?.files ?? [];
  if (featured.length > 0) {
    // The site's article has no cover field; the first file is the cover the
    // author meant, and it must be re-hosted before it can be linked.
    const { expiring } = fileUrl(featured[0]);
    issues.push({
      code: "featured-image-not-carried",
      detail: `${featured.length} file(s)${expiring ? " (signed URL, expires)" : ""}`,
    });
  }

  const publish = options.publish ?? propertyOf(input.page, names.published)?.checkbox === true;
  const date = notionDateToInstant(propertyOf(input.page, names.date)?.date);
  const publishedAt = date ?? (publish ? (options.now?.() ?? new Date()).toISOString() : null);

  const draft: NotionArticleDraft = {
    externalId: input.page.id ?? "",
    slug,
    locale,
    title,
    summary: summary.slice(0, 2000),
    workType,
    tags,
    publish,
    publishedAt,
    contentBlocksVersion: 1,
    contentBlocks: converted.blocks,
  };
  return { draft, issues };
}

/* -------------------------------------------------------------------------- */
/* Article blocks -> Notion blocks                                            */
/* -------------------------------------------------------------------------- */

function richTextFromInlines(
  text: string,
  inlines: readonly { text?: unknown; marks?: unknown; href?: unknown }[] | undefined,
): NotionRichText[] {
  const runs = Array.isArray(inlines) && inlines.length > 0
    ? inlines
    : [{ text }];
  const out: NotionRichText[] = [];
  for (const run of runs) {
    const content = typeof run.text === "string" ? run.text : "";
    if (content.length === 0) continue;
    const marks = Array.isArray(run.marks)
      ? (run.marks as unknown[]).filter((mark): mark is string => typeof mark === "string")
      : [];
    out.push({
      type: "text",
      plain_text: content,
      href: typeof run.href === "string" ? run.href : null,
      text: { content, link: typeof run.href === "string" ? { url: run.href } : null },
      annotations: {
        bold: marks.includes("bold"),
        italic: marks.includes("italic"),
        underline: marks.includes("underline"),
        strikethrough: marks.includes("strikethrough"),
        code: marks.includes("code"),
        color: "default",
      },
    });
  }
  if (out.length === 0 && text.length > 0) {
    out.push({
      type: "text",
      plain_text: text,
      href: null,
      text: { content: text, link: null },
      annotations: { bold: false, italic: false, underline: false, strikethrough: false, code: false, color: "default" },
    });
  }
  return out;
}

/**
 * Article blocks -> Notion blocks, the exact inverse of the mapping above.
 *
 * A `list` becomes consecutive list items (Notion has no list container), a
 * heading of level 2..4 becomes heading_1..3, and images leave as `external`
 * files: the site's own `/api/media/<uuid>` URLs are stable and public, so
 * there is no expiry to copy around on the way out.
 */
export function articleBlocksToNotionBlocks(
  blocks: readonly Record<string, unknown>[],
): { blocks: NotionBlockLike[]; issues: InterchangeIssue[] } {
  const issues: InterchangeIssue[] = [];
  const out: NotionBlockLike[] = [];
  const next = (type: string, payload: Record<string, unknown>): NotionBlockLike => {
    const block: NotionBlockLike = { object: "block", id: `export-${out.length + 1}`, type, has_children: false };
    block[type] = payload;
    out.push(block);
    return block;
  };

  for (const block of blocks) {
    const type = typeof block.type === "string" ? block.type : "";
    const inlines = Array.isArray(block.inlines) ? (block.inlines as { text?: unknown; marks?: unknown; href?: unknown }[]) : undefined;
    if (type === "paragraph" || type === "heading" || type === "quote") {
      const text = typeof block.text === "string" ? block.text : "";
      const rich = richTextFromInlines(text, inlines);
      if (type === "paragraph") next("paragraph", { rich_text: rich, color: "default" });
      else if (type === "quote") {
        const attribution = typeof block.attribution === "string" ? ` — ${block.attribution}` : "";
        next("quote", { rich_text: rich, color: "default" });
        if (attribution.length > 0) next("paragraph", { rich_text: richTextFromInlines(attribution.trim(), undefined), color: "default" });
      } else {
        const level = block.level === 3 ? "heading_2" : block.level === 4 ? "heading_3" : "heading_1";
        next(level, { rich_text: rich, color: "default", is_toggleable: false });
      }
      continue;
    }
    if (type === "list") {
      const ordered = block.ordered === true;
      const items = Array.isArray(block.items) ? block.items : [];
      const itemInlines = Array.isArray(block.itemInlines) ? (block.itemInlines as unknown[]) : [];
      items.forEach((item, index) => {
        const text = typeof item === "string" ? item : "";
        next(ordered ? "numbered_list_item" : "bulleted_list_item", {
          rich_text: richTextFromInlines(text, itemInlines[index] as { text?: unknown }[] | undefined),
          color: "default",
        });
      });
      continue;
    }
    if (type === "image") {
      const src = typeof block.src === "string" ? block.src : "";
      const caption = typeof block.caption === "string" ? block.caption : (typeof block.alt === "string" ? block.alt : "");
      next("image", {
        type: "external",
        external: { url: src },
        caption: caption.length > 0 ? [{ type: "text", plain_text: caption, text: { content: caption, link: null } }] : [],
      });
      continue;
    }
    if (type === "code") {
      const code = typeof block.code === "string" ? block.code : "";
      const language = typeof block.language === "string" ? block.language : "text";
      next("code", { rich_text: richTextFromInlines(code, undefined), language, caption: [] });
      continue;
    }
    issues.push({ code: "unsupported-block", detail: `article block ${type} has no Notion equivalent` });
  }
  return { blocks: out, issues };
}

/**
 * An article edition -> a Notion database page payload.
 *
 * Only the properties the mapping owns are written: the work's own relations
 * (a translation link, a parent item, a manual rank) belong to the database
 * the author built and are not reconstructed from a site that has no such
 * concepts.
 */
export function notionPageFromArticleDraft(
  draft: Pick<NotionArticleDraft, "title" | "summary" | "slug" | "tags" | "publish" | "publishedAt" | "contentBlocks">,
  options: NotionExportOptions = {},
): { properties: Record<string, NotionPropertyValue>; children: NotionBlockLike[]; issues: InterchangeIssue[] } {
  const names = { ...DEFAULT_NOTION_PROPERTY_NAMES, ...(options.propertyNames ?? {}) };
  const { blocks, issues } = articleBlocksToNotionBlocks(draft.contentBlocks);
  const text = (value: string): NotionRichText[] => (value.length > 0 ? richTextFromInlines(value, undefined) : []);
  const date = draft.publishedAt !== null && draft.publishedAt.length >= 10 ? draft.publishedAt.slice(0, 10) : null;

  return {
    properties: {
      Page: { type: "title", title: text(draft.title) },
      [names.slug]: { type: "rich_text", rich_text: text(options.slug ?? draft.slug) },
      [names.summary]: { type: "rich_text", rich_text: text(draft.summary) },
      [names.date]: { type: "date", date: date === null ? null : { start: date } },
      [names.published]: { type: "checkbox", checkbox: draft.publish },
      [names.tags]: { type: "multi_select", multi_select: draft.tags.map((name) => ({ name })) },
    },
    children: blocks,
    issues,
  };
}
