import { parseReadingPosition, type ReadingPosition } from "./reading-position.ts";
import type { ArticleView, Locale, WorkType } from "./content.ts";
import { parseWorkType } from "./work-types.ts";

export const SHELF_LIMIT = 200;
export type ShelfLocale = "zh-CN" | "en";
export type ShelfState = "later" | "reading" | "finished";
export type ShelfMetadata = { slug: string; locale: ShelfLocale; title: string; author: string; workType: WorkType };
export type ShelfRecord = ShelfMetadata & {
  version: 1; state: ShelfState; savedAt: number; updatedAt: number; revision: string;
  tracking: string | null; position: ReadingPosition | null;
};
export type ShelfFilters = { query: string; state: ShelfState | "all"; edition: ShelfLocale | "all"; sort: "recent" | "saved" | "title" | "progress" };
export const DEFAULT_SHELF_FILTERS: ShelfFilters = { query: "", state: "all", edition: "all", sort: "recent" };
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function shelfIdentity(record: Pick<ShelfMetadata, "locale" | "slug">): string {
  return `${record.locale}:${record.slug}`;
}

export function readingListPath(locale: Locale): string {
  return locale === "en" ? "/en/reading-list" : "/reading-list";
}

export function shelfRecordHref(record: Pick<ShelfMetadata, "locale" | "slug">): string {
  return `${record.locale === "en" ? "/en" : ""}/articles/${record.slug}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function shelfToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export function shelfTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

/** Stored/imported strings can be labels, never URLs, markup, or an assertion of consent. */
export function parseShelfMetadata(value: unknown): ShelfMetadata | null {
  if (!plainObject(value)) return null;
  const { slug, locale, title, author, workType } = value;
  if (typeof slug !== "string" || slug.length > 160 || !slugPattern.test(slug)) return null;
  if (locale !== "zh-CN" && locale !== "en") return null;
  // A shelf saved before ADR 0054 can hold a folded type such as "essay"; it is
  // read as its group, not dropped as invalid.
  const type = typeof workType === "string" ? parseWorkType(workType) : null;
  if (!text(title, 200) || !text(author, 200) || !type) return null;
  return { slug, locale, title, author, workType: type };
}

export function shelfMetadataFor(article: ArticleView): ShelfMetadata | null {
  return parseShelfMetadata({ slug: article.slug, locale: article.locale, title: article.title, author: article.author.displayName, workType: article.workType });
}

export function parseShelfRecord(value: unknown): ShelfRecord | null {
  if (!plainObject(value) || value.version !== 1) return null;
  const metadata = parseShelfMetadata(value);
  if (!metadata || !shelfTimestamp(value.savedAt) || !shelfTimestamp(value.updatedAt) || value.updatedAt < value.savedAt) return null;
  if (value.state !== "later" && value.state !== "reading" && value.state !== "finished") return null;
  if (!shelfToken(value.revision) || value.tracking !== null && !shelfToken(value.tracking)) return null;
  const position = value.position === null ? null : parseReadingPosition(value.position);
  if (value.position !== null && position === null) return null;
  return { ...metadata, version: 1, state: value.state, savedAt: value.savedAt, updatedAt: value.updatedAt, revision: value.revision, tracking: value.tracking, position };
}

export function shelfStats(entries: readonly ShelfRecord[]): { total: number; later: number; reading: number; finished: number } {
  return entries.reduce((counts, entry) => { counts.total++; counts[entry.state]++; return counts; }, { total: 0, later: 0, reading: 0, finished: 0 });
}

/** All filtering is local; a title or a reading state never becomes a query sent to a loader. */
export function filterShelf(entries: readonly ShelfRecord[], filters: ShelfFilters): ShelfRecord[] {
  const needle = filters.query.normalize("NFKC").trim().toLocaleLowerCase();
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const filtered = entries.filter(entry => {
    if (filters.state !== "all" && entry.state !== filters.state) return false;
    if (filters.edition !== "all" && entry.locale !== filters.edition) return false;
    return !needle || `${entry.title}\n${entry.author}`.normalize("NFKC").toLocaleLowerCase().includes(needle);
  });
  return filtered.sort((left, right) => {
    let order: number;
    switch (filters.sort) {
      case "saved": order = right.savedAt - left.savedAt; break;
      case "title": order = collator.compare(left.title, right.title); break;
      case "progress": order = (right.position?.percent ?? -1) - (left.position?.percent ?? -1); break;
      default: order = right.updatedAt - left.updatedAt;
    }
    return order || shelfIdentity(left).localeCompare(shelfIdentity(right));
  });
}

export function shelfMetadataChanged(record: ShelfRecord, metadata: ShelfMetadata): boolean {
  return record.title !== metadata.title || record.author !== metadata.author || record.workType !== metadata.workType;
}
