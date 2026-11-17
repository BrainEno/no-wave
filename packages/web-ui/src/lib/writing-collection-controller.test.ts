import assert from "node:assert/strict";
import test from "node:test";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import { createWritingCollection, openWritingCollection } from "./writing-collection.ts";
import { collectionSourcesKey } from "./writing-collection-index.ts";
import { WritingCollectionWorkbench } from "./writing-collection-controller.ts";
const stamp = new Date("2026-11-01T00:00:00.000Z");
const backup = (title: string) => parseWritingBackup(createWritingBackup({ title, summary: "", locale: "en", workType: "essay", editorState: { root: { type: "root", version: 1, children: [{ type: "paragraph", version: 1, children: [{ type: "text", version: 1, text: title }] }] } } }, stamp));
async function fixture(title = "One") { return (await createWritingCollection([{ group: "one", backup: backup(title) }], stamp)).text; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const file = (text: string, name = "file.json") => new File([text], name, { type: "application/json" });
const make = () => new WritingCollectionWorkbench({ read: async input => input.text(), now: () => stamp });

test("a late file read or digest cannot replace a newer file, and clear aborts private work without automatic reload", async () => {
  const old = deferred<string>(), checked = deferred<Awaited<ReturnType<typeof openWritingCollection>>>();
  const text = await fixture(); let reads = 0, opens = 0;
  const controller = new WritingCollectionWorkbench({ read: async () => ++reads === 1 ? old.promise : text, open: async source => ++opens === 2 ? checked.promise : openWritingCollection(source) });
  const first = controller.load("left", file(text, "old.json")); await controller.load("left", file(text, "new.json"));
  old.resolve(text); await first;
  assert.equal(controller.getSnapshot().slots.left.name, "new.json");
  const reading = controller.load("left", file(text, "pending.json")); await new Promise(resolve => setImmediate(resolve));
  controller.clear(); const cleared = controller.getSnapshot();
  checked.resolve(await openWritingCollection(text)); await reading;
  assert.equal(controller.getSnapshot(), cleared);
  assert.equal(controller.getSources().length, 0);
  assert.deepEqual(cleared.selected, []);
});

test("both file slots read independently, reject oversize before I/O and remove only the replaced source's selection", async () => {
  let reads = 0;
  const controller = new WritingCollectionWorkbench({ read: async input => { reads++; return input.text(); } });
  const text = await fixture(); await controller.load("left", file(text)); await controller.load("right", file(text));
  controller.toggleSelection("left:d1"); controller.toggleSelection("right:d1");
  await controller.load("left", new File([" ".repeat(16 * 1024 * 1024 + 1)], "large.json"));
  assert.equal(reads, 2);
  assert.equal(controller.getSnapshot().slots.left.status, "failed");
  assert.deepEqual(controller.getSnapshot().selected, ["right:d1"]);
  assert.equal(controller.getSnapshot().slots.right.status, "ready");
});

test("filter changes are view-only; subset download includes all explicit hidden choices and rejects any changed source/selection witness", async () => {
  const controller = make(), text = await fixture();
  await controller.load("left", file(text)); await controller.load("right", file(text));
  controller.toggleSelection("left:d1"); controller.toggleSelection("right:d1");
  controller.setFilters({ ...controller.getSnapshot().filters, slot: "left" });
  assert.equal(controller.getVisibleRows().length, 1);
  await controller.prepareSubset(); const download = controller.subsetDownload();
  assert.equal(JSON.parse(download.text).entries.length, 2);
  assert.equal(controller.getSnapshot().prepared?.plan.equivalents.length, 1);
  controller.toggleSelection("left:d1"); assert.throws(() => controller.subsetDownload());
  assert.throws(() => controller.singleDownload("left:missing", "json"));
  controller.clear(); assert.equal(controller.getSnapshot().filters.q, "");
});

test("pairing is explicit and bound to current file digests; comparison cancellation and input changes invalidate late results", async () => {
  const pause = deferred<void>(); const controller = new WritingCollectionWorkbench({ read: async input => input.text(), pause: () => pause.promise });
  const text = await fixture(); await controller.load("left", file(text)); await controller.load("right", file(text));
  const witness = collectionSourcesKey(controller.getSources());
  controller.addPair("left:d1", "right:d1", witness);
  assert.equal(controller.getSnapshot().pairs.length, 1);
  const run = controller.compare(); controller.cancelComparison(); pause.resolve(); await run;
  assert.equal(controller.getSnapshot().comparisonStatus, "cancelled");
  assert.equal(controller.getSnapshot().comparisons.length, 0);
  await controller.compare(); assert.equal(controller.getSnapshot().comparisons[0]?.equivalent, true);
  await controller.load("right", file(await fixture("Other")));
  assert.equal(controller.getSnapshot().pairs.length, 0);
  assert.equal(controller.getSnapshot().comparisons.length, 0);
  controller.addPair("left:d1", "right:d1", witness);
  assert.equal(controller.getSnapshot().pairs.length, 0);
  assert.match(controller.getSnapshot().error, /变化/);
});

test("a late preparation cannot resurrect private text after clear, a selection change, or a replacement file", async () => {
  const controller = make(); await controller.load("left", file(await fixture())); controller.toggleSelection("left:d1");
  const run = controller.prepareSubset(); controller.clear(); const snapshot = controller.getSnapshot(); await run;
  assert.equal(controller.getSnapshot(), snapshot);
  assert.throws(() => controller.subsetDownload());
});

test("search changes, reselection and privacy clear fence late snippets and prevent stale navigation", async () => {
  const pause = deferred<void>();
  const controller = new WritingCollectionWorkbench({ read: async input => input.text(), pause: () => pause.promise });
  await controller.load("left", file(await fixture("Private sea")));
  controller.setSearch({ text: "sea", source: "all", scope: "all", caseSensitive: true });
  const pending = controller.runSearch();
  controller.setSearch({ text: "Private", source: "all", scope: "all", caseSensitive: true });
  pause.resolve(); await pending;
  assert.equal(controller.getSnapshot().searchResult, null);
  await controller.runSearch();
  const hit = controller.getSnapshot().searchResult!.matches[0]!;
  assert.equal(controller.searchMatch(hit.id, controller.getSnapshot().searchResult).row.id, "left:d1");
  controller.toggleSelection("left:d1"); controller.toggleSelection("left:d1");
  assert.throws(() => controller.searchMatch(hit.id, controller.getSnapshot().searchResult));
  const late = controller.runSearch(); controller.clear(); const empty = controller.getSnapshot(); await late;
  assert.equal(controller.getSnapshot(), empty);
  assert.equal(empty.search.text, "");
});

test("review plans require an explicit current preview, never auto-apply, and changed local intent or a late read cannot restore it", async () => {
  const controller = make(), text = await fixture();
  await controller.load("left", file(text)); await controller.load("right", file(text));
  controller.toggleSelection("left:d1");
  controller.addPair("left:d1", "right:d1", collectionSourcesKey(controller.getSources()));
  const plan = await controller.reviewPlanDownload();
  controller.clearSelection(); controller.removePair("left:d1|right:d1");
  await controller.loadReviewPlan(file(plan.text, "plan.json"));
  assert.equal(controller.getSnapshot().reviewPreview?.plan.pairs.length, 1);
  assert.deepEqual(controller.getSnapshot().selected, []);
  controller.toggleSelection("right:d1");
  assert.throws(() => controller.applyReviewPlan(controller.getSnapshot().reviewPreview), /预览|失效/);
  await controller.loadReviewPlan(file(plan.text));
  controller.applyReviewPlan(controller.getSnapshot().reviewPreview);
  assert.deepEqual(controller.getSnapshot().selected, ["left:d1"]);
  assert.deepEqual(controller.getSnapshot().pairs, [{ left: "left:d1", right: "right:d1" }]);
  assert.equal(controller.getSnapshot().comparisonStatus, "idle");
  const report = controller.reviewReportDownload("json", false);
  assert.equal(JSON.parse(report.text).pairs[0].state, "unchecked");
  const pending = controller.loadReviewPlan(file(plan.text)); controller.clear(); const empty = controller.getSnapshot(); await pending;
  assert.equal(controller.getSnapshot(), empty);
  assert.equal(empty.reviewPreview, null);
});

test("plan size is checked before I/O and a stale async plan download is refused even after equal-valued reselection", async () => {
  let reads = 0;
  const controller = new WritingCollectionWorkbench({ read: async input => { reads++; return input.text(); } });
  await controller.load("left", file(await fixture()));
  await controller.loadReviewPlan(file(" ".repeat(65537)));
  assert.equal(reads, 1);
  assert.match(controller.getSnapshot().error, /64 KiB/);
  controller.toggleSelection("left:d1");
  const download = controller.reviewPlanDownload();
  controller.toggleSelection("left:d1"); controller.toggleSelection("left:d1");
  await assert.rejects(download, /变化|取消/);
});

test("reference inventory is explicit, cancellable and cannot locate a changed source or old selection", async () => {
  const pause = deferred<void>();
  const controller = new WritingCollectionWorkbench({ read: async input => input.text(), pause: () => pause.promise });
  await controller.load("left", file(await fixture()));
  assert.equal(controller.getSnapshot().references, null);
  const pending = controller.inspectReferences(); controller.cancelReferences(); pause.resolve(); await pending;
  assert.equal(controller.getSnapshot().referenceStatus, "cancelled");
  await controller.inspectReferences();
  assert.equal(controller.getSnapshot().references?.scanned, 1);
  controller.toggleSelection("left:d1");
  assert.equal(controller.getSnapshot().references, null);
  assert.throws(() => controller.referenceDocument("r1", 0, controller.getSnapshot().references));
  controller.setReferenceScope("selected");
  const late = controller.inspectReferences(); controller.clear(); const empty = controller.getSnapshot(); await late;
  assert.equal(controller.getSnapshot(), empty);
  assert.equal(empty.referenceScope, "all");
});

test("reused local hit/group IDs never give an old rendered control authority over a newer completed result or plan preview", async () => {
  const controller = make();
  const input = backup("same word");
  input.draft.editorState!.root.children.push({ type: "image", version: 1, src: "https://example.test/ref.png", alt: "Ref" });
  await controller.load("left", file((await createWritingCollection([{ group: "one", backup: input }], stamp)).text));
  controller.setSearch({ text: "same", caseSensitive: true, scope: "all", source: "all" }); await controller.runSearch();
  const oldSearch = controller.getSnapshot().searchResult!;
  controller.setSearch({ text: "word", caseSensitive: true, scope: "all", source: "all" }); await controller.runSearch();
  assert.throws(() => controller.searchMatch(oldSearch.matches[0]!.id, oldSearch), /变化|失效/);
  await controller.inspectReferences(); const oldReferences = controller.getSnapshot().references!;
  await controller.inspectReferences();
  assert.throws(() => controller.referenceDocument("r1", 0, oldReferences), /变化|过期/);
  controller.toggleSelection("left:d1"); const plan = await controller.reviewPlanDownload();
  await controller.loadReviewPlan(file(plan.text)); const oldPreview = controller.getSnapshot().reviewPreview!;
  await controller.loadReviewPlan(file(plan.text));
  assert.throws(() => controller.applyReviewPlan(oldPreview), /失效/);
});
