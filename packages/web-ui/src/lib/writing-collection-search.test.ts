import assert from "node:assert/strict";
import test from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { createWritingCollection } from "./writing-collection.ts";
import { collectionRows, type CollectionSource } from "./writing-collection-index.ts";
import { DEFAULT_COLLECTION_SEARCH, searchWritingCollection, resolveCollectionSearchMatch } from "./writing-collection-search.ts";

async function source(texts: string[], slot: "left" | "right" = "left"): Promise<CollectionSource> {
  const documents = texts.map((text, index) => ({ group: String(index), backup: parseWritingBackup(createWritingBackup({ title: `Title ${index}`, summary: "not searched 海", locale: "en", workType: "other", editorState: { root: { type: "root", version: 1, children: [
    { type: "paragraph", version: 1, children: [{ type: "text", version: 1, text }] },
    { type: "code", version: 1, language: "plain", children: [{ type: "text", version: 1, text: "never code 海" }] },
    { type: "image", version: 1, src: "https://example.test/no-fetch.png", alt: "never image 海" },
  ] } } })) }));
  return { slot, name: "private.json", opened: { source: "collection", prepared: await createWritingCollection(documents) } };
}

test("cross-manuscript search is literal, scope-aware and separate from metadata; hits resolve only against the original source", async () => {
  const sources = [await source(["海 x.y SEA sea", "nothing"])];
  const report = await searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "x.y" });
  assert.equal(report.matches.length, 1);
  assert.equal(report.scanned, 2);
  assert.equal(report.matches[0]?.match.text, "x.y");
  assert.equal(resolveCollectionSearchMatch(sources, report, report.matches[0]!.id).row.id, "left:d1");
  assert.equal((await searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "SEA", caseSensitive: false })).matches.length, 2);
  assert.equal((await searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "海", scope: "headings" })).matches.length, 0);
  assert.equal((await searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "海" })).matches.length, 1);
  assert.throws(() => resolveCollectionSearchMatch([], report, report.matches[0]!.id), /变化|失效/);
  assert.throws(() => resolveCollectionSearchMatch(sources, report, "missing"));
  assert.equal(collectionRows(sources)[0]?.entry.backup.draft.summary, "not searched 海");
});

test("the global hit budget stops later manuscripts, discloses unread entries and never silently includes unselected files", async () => {
  const sources = [await source(["海 ".repeat(150), "海 unseen"])];
  const report = await searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "海" });
  assert.equal(report.matches.length, 100);
  assert.equal(report.scanned, 1);
  assert.equal(report.remaining, 1);
  assert.equal(report.limited, true);
  const chosen = await searchWritingCollection(sources, ["left:d2"], { ...DEFAULT_COLLECTION_SEARCH, text: "海", source: "selected" });
  assert.equal(chosen.total, 1);
  assert.equal(chosen.matches.length, 1);
  assert.equal(chosen.matches[0]?.rowId, "left:d2");
  await assert.rejects(searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "海", source: "selected" }));
  for (const text of ["", "x".repeat(201), "\u0000"]) await assert.rejects(searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text }));
});

test("search yields between manuscripts and abort rejects instead of publishing partial private snippets", async () => {
  const sources = [await source(["a", "a"])];
  const abort = new AbortController();
  let pauses = 0;
  await assert.rejects(searchWritingCollection(sources, [], { ...DEFAULT_COLLECTION_SEARCH, text: "a" }, abort.signal, async () => { if (++pauses === 2) abort.abort(); }), { name: "AbortError" });
  assert.equal(pauses, 2);
});
