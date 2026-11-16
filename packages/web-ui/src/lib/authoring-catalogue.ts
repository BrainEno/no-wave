import { AUTHORING_ARTICLE_ID_PATTERN, AUTHORING_SLUG_PATTERN, isAuthoringLocale, isRecord } from "@bot-thk/web-http";
import type { WorkType } from "./content.ts";
import { parseWorkType } from "./work-types.ts";

export type CatalogueEntry = {
  id: string; slug: string; title: string; summary: string; locale: string; status: "draft" | "published";
  workType: WorkType; createdAt: string; updatedAt: string; deletedAt: string | null;
};
export type CatalogueFilters = {
  scope: "active" | "trash"; q: string; locale: string; status: "all" | "draft" | "published";
  workType: string; sort: "updated" | "created"; from: string; until: string; limit: number;
};
export type CatalogueFacet = { locale: string; status: "draft" | "published"; workType: string; count: number };
export type CataloguePage = { items: CatalogueEntry[]; total: number; works: number; facets: CatalogueFacet[]; nextCursor: string | null };
export type CatalogueOpenIntent = { id: string; locale: string; actor: string };
export const CATALOGUE_SELECTION_LIMIT = 100;
export const DEFAULT_CATALOGUE_FILTERS: CatalogueFilters = { scope: "active", q: "", locale: "all", status: "all", workType: "all", sort: "updated", from: "", until: "", limit: 20 };

function invalidPage(): never { throw new Error("目录响应不完整或格式不正确，请刷新核对；未修改任何作品。"); }
const safeCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function isoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function readCatalogueEntry(value: unknown): CatalogueEntry {
  if (!isRecord(value) || typeof value.id !== "string" || !AUTHORING_ARTICLE_ID_PATTERN.test(value.id) ||
      typeof value.slug !== "string" || value.slug.length > 160 || !AUTHORING_SLUG_PATTERN.test(value.slug) ||
      typeof value.title !== "string" || value.title.length > 200 || typeof value.summary !== "string" || value.summary.length > 2000 ||
      typeof value.locale !== "string" || !isAuthoringLocale(value.locale) || (value.status !== "draft" && value.status !== "published") ||
      typeof value.workType !== "string" || !parseWorkType(value.workType) || !isoTimestamp(value.createdAt) || !isoTimestamp(value.updatedAt) ||
      value.deletedAt !== null && !isoTimestamp(value.deletedAt)) invalidPage();
  // Pick fields: even a newer server response must not sneak body/identity into a CSV snapshot.
  return { id: value.id, slug: value.slug, title: value.title, summary: value.summary, locale: value.locale,
    status: value.status, workType: parseWorkType(value.workType)!, createdAt: value.createdAt, updatedAt: value.updatedAt, deletedAt: value.deletedAt };
}

export const catalogueEntryKey = (entry: Pick<CatalogueEntry, "id" | "locale">): string => `${entry.id}:${entry.locale}`;

export function readCataloguePage(value: unknown): CataloguePage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 50 || !Array.isArray(value.facets) || value.facets.length > 54 ||
      !safeCount(value.total) || !safeCount(value.works) || value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(value.nextCursor))) invalidPage();
  const items = value.items.map(readCatalogueEntry);
  if (new Set(items.map(catalogueEntryKey)).size !== items.length) invalidPage();
  const facets: CatalogueFacet[] = value.facets.map((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.locale !== "string" || !isAuthoringLocale(raw.locale) ||
        raw.status !== "draft" && raw.status !== "published" || typeof raw.workType !== "string" || !parseWorkType(raw.workType) || !safeCount(raw.count)) invalidPage();
    return { locale: raw.locale, status: raw.status, workType: raw.workType, count: raw.count };
  });
  if (new Set(facets.map(facet => `${facet.locale}:${facet.status}:${facet.workType}`)).size !== facets.length) invalidPage();
  return { items, facets, total: value.total, works: value.works, nextCursor: value.nextCursor };
}

function validDay(value: string): boolean {
  return /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && value < "9999-12-31" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateCatalogueFilters(filters: CatalogueFilters): CatalogueFilters {
  const next = { ...filters, q: filters.q.trim() };
  if (next.q.length > 120 || /[\u0000-\u001f\u007f\p{Cs}]/u.test(next.q)) throw new Error("检索文字最多 120 字符，不能含控制字符。");
  if (next.locale !== "all" && !isAuthoringLocale(next.locale) || !["active", "trash"].includes(next.scope) ||
      !["all", "draft", "published"].includes(next.status) || !["updated", "created"].includes(next.sort) ||
      next.workType !== "all" && !parseWorkType(next.workType) || !Number.isSafeInteger(next.limit) || next.limit < 1 || next.limit > 50) throw new Error("请选择支持的目录筛选条件。");
  if (next.from && !validDay(next.from) || next.until && !validDay(next.until) || next.from && next.until && next.from > next.until) throw new Error("请填写有效的起止日期，结束日期不能早于开始日期。");
  return next;
}
export function catalogueFilterKey(filters: CatalogueFilters): string {
  return JSON.stringify([filters.scope, filters.q, filters.locale, filters.status, filters.workType, filters.sort, filters.from, filters.until, filters.limit]);
}
export function catalogueRequestPath(filters: CatalogueFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== "") params.set(key, String(value));
  if (cursor !== null) params.set("cursor", cursor);
  return `/api/authoring/catalogue?${params}`;
}

/** Counts are editions. Language/status/type facets are intentionally before those three filters. */
export function catalogueFacetCounts(facets: readonly CatalogueFacet[], field: "locale" | "status" | "workType"): Map<string, number> {
  const counts = new Map<string, number>();
  for (const facet of facets) counts.set(facet[field], (counts.get(facet[field]) ?? 0) + facet.count);
  return counts;
}

export function catalogueOpenHref(entry: CatalogueEntry, actor: string): string {
  const params = new URLSearchParams({ catalogueId: entry.id, catalogueLocale: entry.locale, catalogueAuthor: actor });
  return `/write?${params}`;
}
export function parseCatalogueOpenIntent(search: string): CatalogueOpenIntent | null {
  const params = new URLSearchParams(search);
  const fields = ["catalogueId", "catalogueLocale", "catalogueAuthor"];
  if (!fields.some(field => params.has(field))) return null;
  const id = params.get(fields[0]!), locale = params.get(fields[1]!), actor = params.get(fields[2]!);
  if (fields.some(field => params.getAll(field).length !== 1) || !id || !AUTHORING_ARTICLE_ID_PATTERN.test(id) || !locale || !isAuthoringLocale(locale) ||
      !actor || actor.length > 300 || actor.trim() !== actor || /[\u0000-\u001f\u007f\p{Cs}]/u.test(actor)) throw new Error("作品目录链接不完整或无效，编辑区未改变。请返回全部作品重新选择。");
  return { id, locale, actor };
}

export const CATALOGUE_CSV_LABELS = {
  title: "标题", locale: "语言", status: "发布状态", workType: "作品类型", summary: "摘要", slug: "作品地址",
  createdAt: "创建时间 UTC", updatedAt: "更新时间 UTC", deletedAt: "删除时间 UTC",
} as const;
export type CatalogueCsvColumn = keyof typeof CATALOGUE_CSV_LABELS;
export const CATALOGUE_CSV_COLUMNS = Object.keys(CATALOGUE_CSV_LABELS) as CatalogueCsvColumn[];

export function prepareCatalogueCsvValue(value: string): { value: string; removedControls: number; formulaEscaped: boolean } {
  let removedControls = 0;
  let safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, () => { removedControls++; return ""; });
  const formulaEscaped = /^\s*[=+\-@]/u.test(safe) || /^[\t\r\n]/u.test(safe);
  if (formulaEscaped) safe = "'" + safe;
  return { value: safe, removedControls, formulaEscaped };
}
function csvCell(value: string): string {
  return `"${prepareCatalogueCsvValue(value).value.replace(/"/g, '""')}"`;
}

/** A manual index export, not a body backup or proof that the selected snapshots are still current. */
export function catalogueCsv(entries: readonly CatalogueEntry[], columns: readonly CatalogueCsvColumn[] = CATALOGUE_CSV_COLUMNS): string {
  if (!entries.length || entries.length > CATALOGUE_SELECTION_LIMIT || new Set(entries.map(catalogueEntryKey)).size !== entries.length) throw new Error("请选择 1–100 个不重复的语言版本再下载索引。");
  if (columns.length > CATALOGUE_CSV_COLUMNS.length || new Set(columns).size !== columns.length || !columns.includes("title") || !columns.includes("locale") || columns.some(column => !CATALOGUE_CSV_COLUMNS.includes(column))) throw new Error("导出列必须包含标题与语言，且不能重复或包含非元数据字段。");
  const rows: string[][] = [columns.map(column => CATALOGUE_CSV_LABELS[column])];
  for (const source of entries) {
    const entry = readCatalogueEntry(source);
    rows.push(columns.map(column => entry[column] ?? ""));
  }
  return "\ufeff" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
