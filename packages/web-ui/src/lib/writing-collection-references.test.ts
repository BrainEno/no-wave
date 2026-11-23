import assert from "node:assert/strict";
import test from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { createWritingCollection } from "./writing-collection.ts";
import type { CollectionSource } from "./writing-collection-index.ts";
import { collectCollectionReferences, filterCollectionReferences, resolveCollectionReference, DEFAULT_COLLECTION_REFERENCE_FILTERS } from "./writing-collection-references.ts";

async function fixture(count = 2): Promise<CollectionSource[]> {
  const documents = Array.from({ length: count }, (_, index) => ({ group: String(index), backup: parseWritingBackup(createWritingBackup({ title: String(index), summary: "", locale: "en", workType: "other", editorState: { root: { type: "root", version: 1, children: [
    { type: "paragraph", version: 1, children: Array.from({ length: count > 2 ? 15 : 1 }, (_, n) => ({ type: "link", version: 1, url: `http://example.test/${index}-${n}`, children: [{ type: "text", version: 1, text: "Same Label" }] })) },
    { type: "image", version: 1, src: "https://example.test/shared.png", alt: "shared image" },
  ] } } })) }));
  return [{ slot: "left", name: "local.json", opened: { source: "collection", prepared: await createWritingCollection(documents) } }];
}

test("reference inventory merges cross-document use, detects cross-document ambiguous labels and remains text-only", async () => {
  const sources = await fixture();
  const report = await collectCollectionReferences(sources, [], "all");
  assert.equal(report.total, 4);
  assert.equal(report.groups.length, 3);
  const image = report.groups.find(group => group.kind === "image")!;
  assert.equal(image.uses.length, 2);
  assert.equal(image.host, "example.test");
  assert.equal(report.groups.filter(group => group.issues.includes("ambiguous-label")).length, 2);
  const filtered = filterCollectionReferences(report, { ...DEFAULT_COLLECTION_REFERENCE_FILTERS, kind: "image", q: "SHARED", location: "external" });
  assert.deepEqual(filtered, [image]);
  assert.equal(filterCollectionReferences(report, { ...DEFAULT_COLLECTION_REFERENCE_FILTERS, location: "attention" }).length, 2);
  assert.equal(resolveCollectionReference(sources, report, image.id, 1).id, "left:d2");
  assert.throws(() => resolveCollectionReference([], report, image.id, 0));
  assert.throws(() => resolveCollectionReference(sources, report, image.id, -1));
  assert.throws(() => filterCollectionReferences(report, { ...DEFAULT_COLLECTION_REFERENCE_FILTERS, q: "x".repeat(201) }));
  const chosen = await collectCollectionReferences(sources, ["left:d2"], "selected");
  assert.equal(chosen.total, 2);
  assert.equal(chosen.groups.some(group => group.issues.includes("ambiguous-label")), false);
});

test("global reference budgets disclose unfinished documents and abort never yields a partial adopted manifest", async () => {
  const sources = await fixture(20);
  const report = await collectCollectionReferences(sources, [], "all");
  assert.equal(report.groups.length, 200);
  assert.equal(report.limited, true);
  assert.ok(report.remaining > 0);
  assert.ok(report.incomplete.length > 0);
  const abort = new AbortController();
  await assert.rejects(collectCollectionReferences(sources, [], "all", abort.signal, async () => { abort.abort(); }), { name: "AbortError" });
});
