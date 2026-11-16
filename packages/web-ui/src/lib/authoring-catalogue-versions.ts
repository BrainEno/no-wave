import { catalogueEntryKey, readCataloguePage, type CatalogueEntry } from "./authoring-catalogue.ts";
import { writingTextDifference, type WritingTextDifference } from "./writing-compare.ts";

export type CatalogueInspection = {
  source: CatalogueEntry; status: "loading" | "ready" | "failed"; editions: CatalogueEntry[]; error: string;
};

/** Only a complete owned-work read may say a language is absent. A filtered list is not coverage. */
export function readCatalogueEditions(value: unknown, articleId: string, scope: "active" | "trash"): CatalogueEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("语言版本预览不完整，请重新读取。");
  const entries = readCataloguePage({ items: value, facets: [], total: value.length, works: 1, nextCursor: null }).items;
  if (entries.some(entry => entry.id !== articleId || (entry.deletedAt !== null) !== (scope === "trash")) ||
      new Set(entries.map(entry => entry.locale)).size !== entries.length) throw new Error("版本预览不属于所选作品或范围，请重新读取。");
  return entries;
}

export function catalogueCoverage(entries: readonly CatalogueEntry[]): { locale: string; entry: CatalogueEntry | null }[] {
  return ["zh-CN", "en", "zh-TW"].map(locale => ({ locale, entry: entries.find(entry => entry.locale === locale) ?? null }));
}

export function compareCatalogueVersions(entries: readonly CatalogueEntry[], leftLocale: string, rightLocale: string): {
  left: CatalogueEntry; right: CatalogueEntry; fields: { field: "title" | "summary"; difference: WritingTextDifference }[];
} {
  const left = entries.find(entry => entry.locale === leftLocale), right = entries.find(entry => entry.locale === rightLocale);
  if (!left || !right || catalogueEntryKey(left) === catalogueEntryKey(right) || left.id !== right.id) throw new Error("请选择同一作品两个不同的已有语言版本。");
  return { left, right, fields: (["title", "summary"] as const).map(field => ({ field, difference: writingTextDifference(left[field], right[field]) })) };
}
