import assert from "node:assert/strict";
import test from "node:test";
import { catalogueCoverage, compareCatalogueVersions, readCatalogueEditions } from "./authoring-catalogue-versions.ts";
import type { CatalogueEntry } from "./authoring-catalogue.ts";
const row: CatalogueEntry = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", slug: "one", title: "One", summary: "An English summary", status: "draft", workType: "other", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", deletedAt: null };

test("a complete version preview is scoped to one work and never derives missing languages from a filtered page", () => {
  const editions = readCatalogueEditions([row, { ...row, locale: "zh-CN", title: "中文" }], row.id, "active");
  // zh-TW is not offered for new editions, so its slot appears only with a legacy edition.
  assert.deepEqual(catalogueCoverage(editions).map(item => [item.locale, item.entry !== null]), [["zh-CN", true], ["en", true]]);
  const withLegacy = readCatalogueEditions([row, { ...row, locale: "zh-CN", title: "中文" }, { ...row, locale: "zh-TW", title: "舊版" }], row.id, "active");
  assert.deepEqual(catalogueCoverage(withLegacy).map(item => [item.locale, item.entry !== null]), [["zh-CN", true], ["en", true], ["zh-TW", true]]);
  for (const value of [[], [row, row], [{ ...row, id: "a13dbadf-0000-4000-8000-000000000002" }], [{ ...row, deletedAt: row.updatedAt }]]) assert.throws(() => readCatalogueEditions(value, row.id, "active"));
});

test("version comparison is metadata-only, explicit about language choice and reuses bounded text differences", () => {
  const cn = { ...row, locale: "zh-CN", title: "中文标题", summary: "中文摘要" };
  const comparison = compareCatalogueVersions([row, cn], "en", "zh-CN");
  assert.equal(comparison.left.locale, "en");
  assert.equal(comparison.fields.length, 2);
  assert.equal(comparison.fields[0]!.difference.textEqual, false);
  assert.ok(!JSON.stringify(comparison).includes("contentBlocks"));
  assert.throws(() => compareCatalogueVersions([row, cn], "en", "en"));
  assert.throws(() => compareCatalogueVersions([row, cn], "en", "zh-TW"));
});
