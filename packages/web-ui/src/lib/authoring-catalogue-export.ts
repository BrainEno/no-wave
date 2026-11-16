import { CATALOGUE_CSV_COLUMNS, catalogueCsv, catalogueEntryKey, prepareCatalogueCsvValue, readCatalogueEntry, type CatalogueCsvColumn, type CatalogueEntry } from "./authoring-catalogue.ts";
import { catalogueSelectionFingerprint } from "./authoring-catalogue-review.ts";

export type CatalogueExportOptions = { columns: readonly CatalogueCsvColumn[]; order: "selection" | "title" | "updated" };
export type CatalogueExport = {
  csv: string; fingerprint: string; editions: number; works: number; bytes: number; columns: CatalogueCsvColumn[];
  preview: { entryKey: string; cells: { column: CatalogueCsvColumn; value: string }[] }[];
  protectedCells: { entryKey: string; title: string; locale: string; column: CatalogueCsvColumn; removedControls: number; formulaEscaped: boolean }[];
};
export const DEFAULT_CATALOGUE_EXPORT: CatalogueExportOptions = { columns: CATALOGUE_CSV_COLUMNS, order: "selection" };
const titleOrder = new Intl.Collator("zh-Hans", { numeric: true, sensitivity: "variant" });

/** The preflight is computed from exactly the CSV bytes the user will download, never a separate approximation. */
export function buildCatalogueExport(selected: readonly CatalogueEntry[], options: CatalogueExportOptions): CatalogueExport {
  if (!["selection", "title", "updated"].includes(options.order)) throw new Error("请选择支持的本机 CSV 排序。");
  const entries = selected.map(readCatalogueEntry);
  const columns = [...options.columns];
  const fingerprint = catalogueSelectionFingerprint(entries);
  if (options.order !== "selection") entries.sort((left, right) => {
    const primary = options.order === "title" ? titleOrder.compare(left.title, right.title) : Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return primary || left.id.localeCompare(right.id) || left.locale.localeCompare(right.locale);
  });
  const csv = catalogueCsv(entries, columns);
  const protectedCells: CatalogueExport["protectedCells"] = [];
  const preview: CatalogueExport["preview"] = [];
  for (const entry of entries) {
    const entryKey = catalogueEntryKey(entry);
    const cells: CatalogueExport["preview"][number]["cells"] = [];
    for (const column of columns) {
      const prepared = prepareCatalogueCsvValue(entry[column] ?? "");
      cells.push({ column, value: prepared.value });
      if (prepared.removedControls || prepared.formulaEscaped) protectedCells.push({ entryKey, column,
        title: entry.title, locale: entry.locale, removedControls: prepared.removedControls, formulaEscaped: prepared.formulaEscaped });
    }
    if (preview.length < 8) preview.push({ entryKey, cells });
  }
  return { csv, fingerprint, editions: entries.length, works: new Set(entries.map(entry => entry.id)).size,
    bytes: new TextEncoder().encode(csv).byteLength, columns, preview, protectedCells };
}
