import assert from "node:assert/strict";
import test from "node:test";
import { filterShelf, parseShelfRecord, readingListPath, shelfIdentity, shelfRecordHref, shelfStats, type ShelfRecord } from "./reading-shelf.ts";
import { parseShelfBackup, planShelfImport, serializeShelfBackup } from "./reading-shelf-backup.ts";

export function record(overrides: Partial<ShelfRecord> = {}): ShelfRecord {
  return { version: 1, slug: "a-work", locale: "zh-CN", title: "渡口", author: "作者", workType: "other", state: "later", savedAt: 1000, updatedAt: 1000, revision: "revision-1", tracking: null, position: null, ...overrides };
}

test("a shelf identity is one real public language edition, and links never come from imported URLs", () => {
  assert.notEqual(shelfIdentity(record()), shelfIdentity(record({ locale: "en" })));
  assert.equal(shelfRecordHref(record({ locale: "en" })), "/en/articles/a-work");
  assert.equal(readingListPath("en"), "/en/reading-list");
  assert.equal(readingListPath("zh-CN"), "/reading-list");
  for (const slug of ["../account", "https://outside.test", "a/b", "a%2fb", "", "a--b"]) assert.equal(parseShelfRecord({ ...record(), slug }), null);
  assert.equal(parseShelfRecord({ ...record(), locale: "zh-TW" }), null, "there is no zh-TW public article route to invent");
});

test("untrusted shelf records fail closed instead of fabricating consent, statuses or positions", () => {
  assert.deepEqual(parseShelfRecord(record()), record());
  for (const patch of [{ version: 2 }, { title: "" }, { title: "x".repeat(201) }, { author: "a\u0000b" }, { state: "administrator" }, { savedAt: -1 }, { updatedAt: 999 }, { revision: "" }, { tracking: true }, { position: {} }]) {
    assert.equal(parseShelfRecord({ ...record(), ...patch }), null);
  }
  assert.equal(parseShelfRecord(null), null);
  assert.equal(parseShelfRecord([]), null);
  const parsed = parseShelfRecord({ ...record(), href: "https://outside.test", accessToken: "not-a-real-credential" });
  assert.deepEqual(parsed, record(), "unknown fields never reach storage, links or export");
});

test("local filters compose, stable sorts do not mutate source, and counts remain global", () => {
  const rows = [record(), record({ slug: "second", title: "River", locale: "en", state: "reading", updatedAt: 2000 }), record({ slug: "third", state: "finished" })];
  const original = [...rows];
  assert.deepEqual(filterShelf(rows, { query: "  river ", state: "reading", edition: "en", sort: "recent" }).map(x => x.slug), ["second"]);
  assert.equal(filterShelf(rows, { query: "作者", state: "all", edition: "all", sort: "saved" }).length, 3);
  assert.deepEqual(shelfStats(rows), { total: 3, later: 1, reading: 1, finished: 1 });
  assert.deepEqual(rows, original);
});

test("backup round trips public metadata and position but never starts tracking on import", () => {
  const encoded = serializeShelfBackup([record({ tracking: "consent-1" })], 2000);
  const backup = parseShelfBackup(encoded);
  assert.equal(backup.ok, true);
  if (!backup.ok) return;
  assert.equal(backup.entries[0]?.tracking, null);
  assert.equal(backup.entries[0]?.title, "渡口");
  assert.ok(!encoded.includes("consent-1"));
});

test("damaged, oversized, duplicate and future backups are rejected as a whole", () => {
  const pack = (entries: unknown[], version = 1) => JSON.stringify({ format: "no-wave-reading-list", version, exportedAt: 2000, entries });
  for (const input of ["{", "null", pack([record()], 2), pack([record(), record()]), pack([record(), {}]), "x".repeat(1_048_577)]) assert.equal(parseShelfBackup(input).ok, false);
  assert.equal(parseShelfBackup(pack(Array.from({ length: 201 }, (_, i) => record({ slug: `work-${i}` })))).ok, false);
});

test("import previews default to preserving existing data, enforce capacity and do not mutate input", () => {
  const old = record({ title: "My title", tracking: "consent-1" });
  const incoming = [record({ title: "Backup title" }), record({ slug: "second", tracking: "another-device" })];
  const keep = planShelfImport([old], incoming, "keep", 0);
  assert.equal(keep.ok, true);
  if (!keep.ok) return;
  assert.deepEqual({ added: keep.added, replaced: keep.replaced, kept: keep.kept }, { added: 1, replaced: 0, kept: 1 });
  assert.equal(keep.writes[0]?.tracking, null);
  const replace = planShelfImport([old], incoming, "replace", 0);
  assert.equal(replace.ok, true);
  if (replace.ok) assert.equal(replace.replaced, 1);
  assert.equal(old.title, "My title");
  assert.equal(incoming[1]?.tracking, "another-device");
  const full = Array.from({ length: 200 }, (_, i) => record({ slug: `work-${i}` }));
  assert.equal(planShelfImport(full, incoming, "keep", 0).ok, false);
  assert.equal(planShelfImport([], incoming, "keep", 199).ok, false, "unreadable slots are not silently overwritten");
});
