import assert from "node:assert/strict";
import test from "node:test";
import { catalogueCsv, catalogueEntryKey, catalogueOpenHref, parseCatalogueOpenIntent, readCataloguePage, type CatalogueEntry } from "./authoring-catalogue.ts";

export const entry: CatalogueEntry = { id: "a13dbadf-0000-4000-8000-000000000001", locale: "en", slug: "one-work", title: "One work", summary: "A summary", status: "draft", workType: "essay", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", deletedAt: null };

test("catalogue response validation rejects duplicate editions, unbounded arrays and malformed data", () => {
  const page = { items: [entry], total: 1, works: 1, facets: [{ locale: "en", status: "draft", workType: "essay", count: 1 }], nextCursor: null };
  assert.deepEqual(readCataloguePage(page).items, [entry]);
  for (const patch of [{ items: [entry, entry] }, { items: Array(51).fill(entry) }, { total: -1 }, { nextCursor: "javascript:bad" }, { facets: [{ ...page.facets[0], count: 0.5 }] }, { items: [{ ...entry, updatedAt: "not a date" }] }, { items: [{ ...entry, locale: "fr" }] }]) {
    assert.throws(() => readCataloguePage({ ...page, ...patch }));
  }
  assert.equal(catalogueEntryKey(entry), `${entry.id}:en`);
});

test("CSV is only explicit metadata, quotes cells, preserves Unicode and protects spreadsheet formulas", () => {
  const csv = catalogueCsv([{ ...entry, title: '  =HYPERLINK("https://example.test")', summary: '中文, quoted "text"\nnext' }]);
  assert.ok(csv.startsWith("\ufeff"));
  assert.ok(csv.includes('"\'  =HYPERLINK(""https://example.test"")"'));
  assert.ok(csv.includes('"中文, quoted ""text""\nnext"'));
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(!csv.includes("contentBlocks") && !csv.includes("revision") && !csv.includes("authorId"));
  for (const title of ["+1+1", "-2+3", "@SUM(1)", "\t=1", "\u200b=1"]) assert.ok(catalogueCsv([{ ...entry, title }]).includes('"\''));
  assert.throws(() => catalogueCsv([]));
  assert.throws(() => catalogueCsv(Array(101).fill(entry)));
  assert.throws(() => catalogueCsv([entry, entry]));
});

test("a catalogue editor link is an exact, restrictive account/id/locale intent, never an external URL", () => {
  const href = catalogueOpenHref(entry, "account/中文");
  assert.ok(href.startsWith("/write?"));
  const parsed = parseCatalogueOpenIntent(new URL(href, "https://example.test").search)!;
  assert.deepEqual(parsed, { id: entry.id, locale: "en", actor: "account/中文" });
  assert.equal(parseCatalogueOpenIntent("?unrelated=1"), null);
  for (const search of ["?catalogueId=bad", `?catalogueId=${entry.id}&catalogueLocale=fr&catalogueAuthor=a`, `?catalogueId=${entry.id}&catalogueLocale=en&catalogueAuthor=a&catalogueAuthor=b`]) assert.throws(() => parseCatalogueOpenIntent(search));
});
