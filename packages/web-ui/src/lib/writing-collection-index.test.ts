import assert from "node:assert/strict";
import test from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { createWritingCollection, type OpenedCollection } from "./writing-collection.ts";
import { collectionRows, filterCollectionRows, selectedCollectionRows, collectionSourcesKey, planCollectionSubset, prepareCollectionSubset, collectionSingleDownload, validateCollectionPairs, compareCollectionPair, unpairedCollectionRows, DEFAULT_COLLECTION_FILTERS } from "./writing-collection-index.ts";
import type { WritingDraft } from "./writing-session.ts";
const now = new Date("2026-11-01T00:00:00.000Z");
const draft = (title: string, locale = "zh-CN", text = title): WritingDraft => ({ title, summary: "literal %_", locale, workType: "essay", editorState: { root: { type: "root", version: 1, children: [{ type: "paragraph", version: 1, children: [{ type: "text", version: 1, text }] }] } } });
async function sources() {
  const left: OpenedCollection = { source: "collection", prepared: await createWritingCollection(["文稿10", "文稿2"].map(title => ({ group: title, backup: parseWritingBackup(createWritingBackup(draft(title), now)) })), now) };
  const right: OpenedCollection = { source: "collection", prepared: await createWritingCollection([{ group: "separate", backup: parseWritingBackup(createWritingBackup(draft("文稿10"), now)) }], now) };
  return [{ slot: "right" as const, name: "right.json", opened: right }, { slot: "left" as const, name: "left.json", opened: left }];
}

test("the local index keeps source-local groups separate and deterministic, with literal title/summary filters and view-only sorting", async () => {
  const input = await sources(); const rows = collectionRows(input);
  assert.deepEqual(rows.map(row => row.id), ["left:d1", "left:d2", "right:d1"]);
  assert.notEqual(rows[0]!.group, rows[2]!.group);
  assert.deepEqual(filterCollectionRows(rows, { ...DEFAULT_COLLECTION_FILTERS, q: "%_", slot: "right" }, []).map(row => row.id), ["right:d1"]);
  assert.deepEqual(filterCollectionRows(rows, { ...DEFAULT_COLLECTION_FILTERS, sort: "title" }, []).map(row => row.entry.backup.draft.title), ["文稿2", "文稿10", "文稿10"]);
  assert.equal(filterCollectionRows(rows, { ...DEFAULT_COLLECTION_FILTERS, q: "LITERAL" }, []).length, 0);
  assert.deepEqual(filterCollectionRows(rows, { ...DEFAULT_COLLECTION_FILTERS, onlySelected: true }, ["left:d2"]).map(row => row.id), ["left:d2"]);
  assert.throws(() => filterCollectionRows(rows, { ...DEFAULT_COLLECTION_FILTERS, q: "x".repeat(121) }, []));
});

test("subset selection never trusts stale keys or checkbox click order, reports equivalents but does not silently merge or deduplicate", async () => {
  const input = await sources(), rows = collectionRows(input);
  assert.deepEqual(selectedCollectionRows(rows, ["right:d1", "left:d1"]).map(row => row.id), ["left:d1", "right:d1"]);
  for (const keys of [[], ["missing"], ["left:d1", "left:d1"]]) assert.throws(() => selectedCollectionRows(rows, keys));
  const plan = planCollectionSubset(input, ["right:d1", "left:d1"]);
  assert.equal(plan.equivalents.length, 1);
  assert.equal(plan.groups, 2);
  const built = await prepareCollectionSubset(input, ["right:d1", "left:d1"], now);
  assert.equal(built.prepared.collection.entries.length, 2);
  assert.deepEqual(built.prepared.collection.entries.map(entry => entry.group), ["w1", "w2"]);
  assert.notEqual(plan.fingerprint, planCollectionSubset(input, ["left:d2"]).fingerprint);
  assert.equal(collectionSourcesKey(input), collectionSourcesKey([...input].reverse()));
});

test("single downloads stay compatible with old JSON restoration and explicit lossy text/Markdown exports", async () => {
  const row = collectionRows(await sources())[0]!;
  const json = collectionSingleDownload(row, "json");
  assert.deepEqual(parseWritingBackup(json.text).draft, row.entry.backup.draft);
  assert.match(json.name, /^[A-Za-z0-9_-]+-2026-11-01\.json$/);
  assert.equal(json.mime, "application/json;charset=utf-8");
  assert.match(collectionSingleDownload(row, "markdown").text, /^# 文稿10/);
  assert.match(collectionSingleDownload(row, "text").text, /^文稿10/);
  assert.doesNotMatch(json.text, /digest|group|authorId|revision|slug/);
});

test("cross-file comparison requires an explicit unique left/right mapping; unpaired never means deleted", async () => {
  const input = await sources(), rows = collectionRows(input);
  const pairs = [{ left: "left:d1", right: "right:d1" }];
  validateCollectionPairs(rows, pairs);
  assert.equal(compareCollectionPair(rows, pairs[0]!).equivalent, true);
  assert.deepEqual(unpairedCollectionRows(rows, pairs).map(row => row.id), ["left:d2"]);
  for (const bad of [[{ left: "left:d1", right: "left:d2" }], [...pairs, { left: "left:d2", right: "right:d1" }], [{ left: "left:d3", right: "right:d1" }]]) assert.throws(() => validateCollectionPairs(rows, bad));
  const right = rows.find(row => row.id === "right:d1")!;
  right.entry.backup.draft.title = "Later title";
  const comparison = compareCollectionPair(rows, pairs[0]!);
  assert.equal(comparison.equivalent, false);
  assert.equal(comparison.comparison.fields[0]?.field, "title");
});
