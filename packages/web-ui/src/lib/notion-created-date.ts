import { notionDateStart } from "./notion-markdown.ts";

/**
 * Optional `Date` backfill from a page's creation date (ADR 0052, P2).
 *
 * The import reads a published page's date from its `Date` property, and a
 * published page without one is dated at the moment of the import — so a
 * database written over years arrives as if every work appeared today. Notion
 * knows when each page was created: the API returns `created_time` with every
 * row, and a database CSV carries it when the author added a "Created time"
 * property. The desk can offer that date, and only that:
 *
 * - it is the author's choice, off by default, and it changes the plan, so the
 *   plan must be made again after it is switched;
 * - it fills a `Date` that is missing or empty and never replaces one, however
 *   it is spelled;
 * - it fills published pages only. A draft has no publication date to be
 *   wrong — the site uses the actual moment it is published — so giving it one
 *   would change what a draft is, not repair it;
 * - every page it fills is listed with the date it got, before the dry run.
 *
 * The date is a calendar day, as a Notion `Date` usually is: the day the author
 * saw in Notion. For an API instant that is the browser's local day (the author's
 * own calendar); a CSV already prints it in the exporter's local time, so its date
 * part is read as written. The value is stored as UTC midnight of that day — the
 * same rule `notionDateStart` and the API apply to every calendar date.
 */

/** A creation date in any form the desk receives it, as UTC midnight of its calendar day. */
export function createdDay(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  // An API instant ("2024-05-01T17:00:00.000Z"): the author's local calendar day.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return null;
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    return notionDateStart(day)?.start ?? null;
  }
  // A CSV cell: Notion prints "October 8, 2026 3:04 PM" or "2026年10月8日 15:04";
  // the clock time is the exporter's local time and is not needed for a day.
  const datePart = value
    .replace(/\s+(?:上午|下午|中午|晚上|凌晨)?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?(?:\s*\([^)]*\)|\s+[A-Z]{2,5}|\s+GMT[+-]\d{1,2}(?::?\d{2})?)?$/, "")
    .trim();
  const parsed = notionDateStart(datePart);
  return parsed === null || parsed.range ? null : parsed.start;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing, or a date property with no start. Any other value — even of another type — is the author's and is left alone. */
function dateIsMissing(properties: Record<string, unknown>): boolean {
  const value = properties.Date;
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || value.type !== "date") return false;
  const date = value.date;
  return date === null || date === undefined || (isRecord(date) && (typeof date.start !== "string" || date.start.trim() === ""));
}

function isPublished(properties: Record<string, unknown>): boolean {
  const value = properties.Published;
  return isRecord(value) && value.checkbox === true;
}

export type DateBackfill = {
  bundle: Record<string, unknown>;
  /** Pages that got a date, by bundle index, with the calendar day (`YYYY-MM-DD`). */
  filled: { index: number; day: string }[];
};

/**
 * Fill `Date` from `created` (page id → `createdDay` value) where the rules above
 * allow it. The input is not modified; pages and their order are unchanged.
 */
export function fillMissingDates(bundle: Record<string, unknown>, created: ReadonlyMap<string, string>): DateBackfill {
  if (!Array.isArray(bundle.pages) || created.size === 0) return { bundle, filled: [] };
  const filled: { index: number; day: string }[] = [];
  const pages = bundle.pages.map((page: unknown, index: number) => {
    if (!isRecord(page) || typeof page.id !== "string" || !isRecord(page.properties)) return page;
    const start = created.get(page.id);
    if (start === undefined || !isPublished(page.properties) || !dateIsMissing(page.properties)) return page;
    filled.push({ index, day: start.slice(0, 10) });
    return { ...page, properties: { ...page.properties, Date: { type: "date", date: { start } } } };
  });
  return filled.length === 0 ? { bundle, filled } : { bundle: { ...bundle, pages }, filled };
}
