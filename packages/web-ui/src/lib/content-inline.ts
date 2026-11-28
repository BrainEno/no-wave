import { sanitizeEditorHref } from "./editor-href.ts";

/**
 * The read side of the inline formatting contract.
 *
 * The application-owned content contract version 1 stores a paragraph, a heading
 * or a quote as a plain-text fallback plus a list of inline runs. Each run
 * carries its own text, an optional set of marks and an optional link. The API
 * validates that contract on the way in; this module is the read side of the
 * same rule, so a reader sees exactly what an author wrote.
 *
 * It used to be that only the comment surface rendered runs. The article
 * surface rendered the plain-text fallback and dropped every mark and every
 * link, so a published work silently lost its emphasis and its hyperlinks —
 * a defect no API test could see, because the API had stored the document
 * correctly all along.
 *
 * The rules live here, in a plain module, rather than in a component:
 *
 * - an unknown mark is ignored, never rendered as an element;
 * - a link that is not a safe HTTP(S) URL or a site-absolute path is rendered
 *   as plain text. A stored document is data, not markup, so a hostile scheme
 *   that reached the database — through an older writer, a direct import or a
 *   provider replay — cannot become an active link in a reader's browser;
 * - an empty run is dropped.
 */

/** The marks the content contract version 1 defines. */
export const INLINE_MARKS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
] as const;

export type InlineMark = (typeof INLINE_MARKS)[number];

/** One run of a paragraph, heading, quote or list item. */
export type InlineRun = { text: string; marks?: string[]; href?: string };

/**
 * What the renderer should draw. A run with an unusable link becomes a text
 * segment: the words stay, the link does not.
 */
export type InlineSegment =
  | { kind: "text"; text: string; marks: readonly InlineMark[] }
  | { kind: "link"; text: string; marks: readonly InlineMark[]; href: string };

export function isInlineMark(value: unknown): value is InlineMark {
  return (
    typeof value === "string" &&
    (INLINE_MARKS as readonly string[]).includes(value)
  );
}

/** The marks of a run that the contract actually defines, in contract order. */
export function inlineMarks(run: InlineRun): readonly InlineMark[] {
  const marks = run.marks;
  if (!Array.isArray(marks)) return [];
  return INLINE_MARKS.filter((mark) => marks.includes(mark));
}

/** A run is usable when it is an object with a non-empty string of text. */
export function isInlineRun(value: unknown): value is InlineRun {
  if (typeof value !== "object" || value === null) return false;
  const run = value as { text?: unknown; marks?: unknown; href?: unknown };
  if (typeof run.text !== "string" || run.text.length === 0) return false;
  if (run.marks !== undefined && !Array.isArray(run.marks)) return false;
  if (run.href !== undefined && typeof run.href !== "string") return false;
  return true;
}

/**
 * The href a run may be linked to, or `null` when it must not be linked.
 * The rule is the editor's own, so a link that the writer could not create
 * cannot be read either.
 */
export function inlineHref(run: InlineRun): string | null {
  if (run.href === undefined) return null;
  return sanitizeEditorHref(run.href);
}

/** Turn a run list into the segments a renderer draws. */
export function inlineSegments(runs: readonly InlineRun[]): InlineSegment[] {
  const segments: InlineSegment[] = [];
  for (const run of runs) {
    if (!isInlineRun(run) || run.text.length === 0) continue;
    const marks = inlineMarks(run);
    const href = inlineHref(run);
    segments.push(
      href === null
        ? { kind: "text", text: run.text, marks }
        : { kind: "link", text: run.text, marks, href },
    );
  }
  return segments;
}

/**
 * The runs of a block, or an empty list when it carries none.
 *
 * Reading a block's runs is a boundary: the value comes from the API, and a
 * payload that is not a list of runs is not a reason to fail the page.
 */
export function blockInlineRuns(value: unknown): InlineRun[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isInlineRun);
}

/**
 * The runs of each list item, in the order the items are stored.
 *
 * A payload whose shape is wrong yields no runs at all rather than a partly
 * filled list: the reader then draws the plain items, which is a document the
 * author wrote, instead of a list whose items disagree with each other.
 */
export function blockItemInlines(value: unknown): InlineRun[][] {
  if (!Array.isArray(value)) return [];
  if (!value.every((item) => Array.isArray(item))) return [];
  return value.map((item) => blockInlineRuns(item));
}
