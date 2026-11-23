import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogueExport, DEFAULT_CATALOGUE_EXPORT } from "./authoring-catalogue-export.ts";
import { catalogueCsv, type CatalogueEntry } from "./authoring-catalogue.ts";
const row: CatalogueEntry = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", slug: "one", title: "One", summary: "A summary", status: "draft", workType: "other", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", deletedAt: null };

test("CSV export preflight matches the actual bytes, keeps default compatibility and never changes selection", () => {
  const selected = [row, { ...row, locale: "zh-CN", title: "中文" }];
  const report = buildCatalogueExport(selected, DEFAULT_CATALOGUE_EXPORT);
  assert.equal(report.csv, catalogueCsv(selected));
  assert.equal(report.bytes, Buffer.byteLength(report.csv, "utf8"));
  assert.equal(report.editions, 2); assert.equal(report.works, 1);
  assert.equal(report.protectedCells.length, 0);
  assert.deepEqual(selected.map(entry => entry.locale), ["en", "zh-CN"]);
});

test("explicit export columns can omit summaries; title and language remain mandatory, unknown/duplicate fields fail closed", () => {
  const report = buildCatalogueExport([row], { columns: ["title", "locale", "updatedAt"], order: "selection" });
  assert.equal(report.columns.length, 3);
  assert.ok(!report.csv.includes("A summary") && !report.csv.includes("摘要"));
  assert.equal(report.preview[0]!.cells.length, 3);
  for (const columns of [["title"], ["locale"], ["title", "locale", "title"], ["title", "locale", "authorId"], []]) assert.throws(() => buildCatalogueExport([row], { columns: columns as never, order: "selection" }));
  assert.throws(() => buildCatalogueExport([row], { columns: ["title", "locale"], order: "remote" as never }));
});

test("preflight discloses formula/control protection, previews the protected value and quotes newlines without mutation", () => {
  const source = { ...row, title: "\u200b=SUM(1)", summary: 'line, "quoted"\nnext' };
  const report = buildCatalogueExport([source], DEFAULT_CATALOGUE_EXPORT);
  const notice = report.protectedCells.find(cell => cell.column === "title")!;
  assert.equal(notice.removedControls, 1);
  assert.equal(notice.formulaEscaped, true);
  assert.equal(report.preview[0]!.cells[0]!.value, "'=SUM(1)");
  assert.equal(source.title, "\u200b=SUM(1)");
  assert.ok(report.csv.includes('"line, ""quoted""\nnext"'));
});

test("export ordering is local, stable and independent of page order; preview never silently expands the chosen export", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ ...row, id: `a13dbadf-0000-4000-8000-${String(index).padStart(12, "0")}`, title: `Title ${11 - index}`, updatedAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }));
  const title = buildCatalogueExport(entries, { ...DEFAULT_CATALOGUE_EXPORT, order: "title" });
  assert.equal(title.preview[0]!.cells[0]!.value, "Title 0");
  const updated = buildCatalogueExport(entries, { ...DEFAULT_CATALOGUE_EXPORT, order: "updated" });
  assert.equal(updated.preview[0]!.entryKey, `${entries.at(-1)!.id}:en`);
  assert.equal(updated.preview.length, 8);
  assert.equal(updated.editions, 12);
  assert.equal(entries[0]!.title, "Title 11");
});
