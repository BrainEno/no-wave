import assert from "node:assert/strict";
import { test } from "node:test";
import { createdDay, fillMissingDates } from "./notion-created-date.ts";

/**
 * The optional "use the creation date" backfill: what it reads, and — as much —
 * what it must leave alone.
 */

test("a creation value becomes UTC midnight of its calendar day", () => {
  // A CSV prints the exporter's local time; its date part is taken as written.
  assert.equal(createdDay("October 8, 2026 3:04 PM"), "2026-10-08T00:00:00.000Z");
  assert.equal(createdDay("2026年10月8日 15:04"), "2026-10-08T00:00:00.000Z");
  assert.equal(createdDay("2026/10/08 下午 3:04"), "2026-10-08T00:00:00.000Z");
  assert.equal(createdDay("2026-10-08"), "2026-10-08T00:00:00.000Z");
  assert.equal(createdDay("October 8, 2026 3:04 PM (GMT+8)"), "2026-10-08T00:00:00.000Z");
  for (const value of ["", "  ", "yesterday", "2026-02-30", "2026-10-08 → 2026-10-09"]) assert.equal(createdDay(value), null, value);
});

test("an API instant is the day on the author's own calendar", () => {
  const at = new Date("2024-05-01T23:30:00.000Z");
  const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}T00:00:00.000Z`;
  assert.equal(createdDay("2024-05-01T23:30:00.000Z"), local);
  assert.equal(createdDay("2024-05-01T12:00:00+00:00")?.slice(0, 7), "2024-05");
});

const page = (id: string, properties: Record<string, unknown>) => ({ id, properties: { Name: { type: "title", title: [{ plain_text: id }] }, ...properties }, blocks: [] });
const published = { Published: { type: "checkbox", checkbox: true } };
const day = "2024-05-01T00:00:00.000Z";

test("only a published page with no Date is filled, and the input is not changed", () => {
  const bundle = {
    version: 1,
    database: { id: "", title: "x" },
    pages: [
      page("missing", published),
      page("empty", { ...published, Date: { type: "date", date: null } }),
      page("blank-start", { ...published, Date: { type: "date", date: { start: "" } } }),
      page("dated", { ...published, Date: { type: "date", date: { start: "2020-01-01" } } }),
      page("draft", { Published: { type: "checkbox", checkbox: false } }),
      page("unmarked", {}),
      page("other-type", { ...published, Date: { type: "rich_text", rich_text: [{ plain_text: "某天" }] } }),
      page("no-created", published),
    ],
  };
  const before = JSON.stringify(bundle);
  const created = new Map(["missing", "empty", "blank-start", "dated", "draft", "unmarked", "other-type"].map((id) => [id, day]));
  const result = fillMissingDates(bundle, created);
  assert.equal(JSON.stringify(bundle), before);
  assert.deepEqual(result.filled, [{ index: 0, day: "2024-05-01" }, { index: 1, day: "2024-05-01" }, { index: 2, day: "2024-05-01" }]);
  const pages = result.bundle.pages as { id: string; properties: Record<string, unknown> }[];
  assert.deepEqual(pages.map((p) => p.id), bundle.pages.map((p) => p.id));
  for (const index of [0, 1, 2]) assert.deepEqual(pages[index]!.properties.Date, { type: "date", date: { start: day } });
  for (const index of [3, 4, 5, 6, 7]) assert.equal(pages[index], bundle.pages[index]);
});

test("nothing to fill returns the same bundle", () => {
  const bundle = { version: 1, pages: [page("a", published)] };
  assert.equal(fillMissingDates(bundle, new Map()).bundle, bundle);
  assert.equal(fillMissingDates(bundle, new Map([["b", day]])).bundle, bundle);
});
