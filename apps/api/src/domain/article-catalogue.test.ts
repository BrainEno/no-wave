import assert from "node:assert/strict";
import test from "node:test";
import { decodeArticleCatalogueCursor, encodeArticleCatalogueCursor, parseArticleCatalogueQuery } from "./article-catalogue.ts";

const query = (value = "") => parseArticleCatalogueQuery(new URLSearchParams(value));
const point = { at: "2026-11-01T12:34:56.123456Z", id: "a13dbadf-0000-4000-8000-000000000001", locale: "en" };

test("catalogue query defaults are bounded, cross-locale and explicit about literal search", () => {
  assert.deepEqual(query(), { scope: "active", q: "", locale: "all", status: "all", workType: "all", sort: "updated", from: "", until: "", limit: 20, cursor: null });
  assert.equal(query("q=%20%25_%E4%B8%AD%E6%96%87%20").q, "%_中文");
  assert.equal(query("scope=trash&locale=zh-TW&workType=novel&limit=50").workType, "novel");
  assert.throws(() => query("workType=serial"), undefined, "a folded type is no longer a filter value");
  assert.equal(query("from=2024-02-29&until=2024-03-01").from, "2024-02-29");
});

test("ambiguous, unsafe and calendar-invalid catalogue queries fail closed", () => {
  for (const value of ["limit=0", "limit=51", "limit=1e1", "limit=01", "locale=fr", "q=a&q=b", "actorId=somebody", "allLocales=true", "scope=all", "status=deleted", "workType=unknown", "sort=title", "cursor=", "from=2025-02-29", "until=2026-04-31", "from=2026-11-02&until=2026-11-01", "from=0000-01-01", "q=%00", `q=${"a".repeat(121)}`]) {
    assert.throws(() => query(value), undefined, value);
  }
});

test("a catalogue cursor is exact, preserves PostgreSQL microseconds and is bound to actor and filters", () => {
  const filters = query("q=中文&status=draft&from=2026-01-01");
  const cursor = encodeArticleCatalogueCursor(point, "author-a", filters);
  assert.deepEqual(decodeArticleCatalogueCursor(cursor, "author-a", filters), point);
  assert.ok(!Buffer.from(cursor, "base64url").toString().includes("author-a"));
  assert.throws(() => decodeArticleCatalogueCursor(cursor, "author-b", filters));
  assert.throws(() => decodeArticleCatalogueCursor(cursor, "author-a", { ...filters, status: "all" }));
  assert.throws(() => decodeArticleCatalogueCursor(cursor, "author-a", { ...filters, scope: "trash" }));
  assert.deepEqual(decodeArticleCatalogueCursor(cursor, "author-a", { ...filters, limit: 5 }), point, "page size is not an ownership or filter change");
});

test("noncanonical encodings, unknown cursor fields, forged timestamps and unsafe ids are refused", () => {
  const filters = query();
  const cursor = encodeArticleCatalogueCursor(point, "author", filters);
  const raw = JSON.parse(Buffer.from(cursor, "base64url").toString());
  for (const value of [cursor + "=", "!", "a".repeat(1025), Buffer.from(JSON.stringify({ ...raw, extra: true })).toString("base64url"),
    ...[{ ...point, at: "2026-02-30T12:34:56.123Z" }, { ...point, at: "2026-11-01T12:34:56Z" }, { ...point, id: "' OR 1=1 --" }, { ...point, locale: "fr" }].map(p => Buffer.from(JSON.stringify({ ...raw, ...p })).toString("base64url"))]) {
    assert.throws(() => decodeArticleCatalogueCursor(value, "author", filters));
  }
});
