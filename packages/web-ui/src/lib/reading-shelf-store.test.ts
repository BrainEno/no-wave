import assert from "node:assert/strict";
import test from "node:test";
import { createReadingShelfStore, SHELF_STORAGE_PREFIX, type ShelfStorage } from "./reading-shelf-store.ts";
import { captureReadingPosition } from "./reading-position.ts";
import { shelfIdentity, type ShelfMetadata } from "./reading-shelf.ts";

class MemoryStorage implements ShelfStorage {
  values = new Map<string, string>();
  denyWrites = false;
  writesBeforeFailure = Infinity;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.denyWrites || --this.writesBeforeFailure < 0) throw Object.assign(new Error("denied"), { name: "QuotaExceededError" });
    this.values.set(key, value);
  }
  removeItem(key: string) { if (this.denyWrites) throw new Error("denied"); this.values.delete(key); }
}
const metadata: ShelfMetadata = { slug: "river", locale: "zh-CN", title: "渡口", author: "作者", workType: "essay" };
const identity = shelfIdentity(metadata);
function setup(storage = new MemoryStorage()) {
  let nonce = 0;
  const store = createReadingShelfStore({ now: () => 2000, nonce: () => `revision-${++nonce}` });
  store.connect(storage);
  return { storage, store };
}

test("initial SSR state contains no local data; reading never writes and records only follow explicit save", () => {
  const store = createReadingShelfStore();
  assert.equal(store.getServerSnapshot().status, "loading");
  const { storage, store: ready } = setup();
  assert.equal(storage.length, 0);
  assert.equal(ready.getSnapshot().entries.length, 0);
  assert.equal(ready.save(metadata).ok, true);
  assert.equal(ready.getSnapshot().entries[0]?.state, "later");
  assert.equal(ready.getSnapshot().entries[0]?.tracking, null);
  assert.equal(ready.save(metadata).ok, true);
  assert.equal(ready.getSnapshot().entries.length, 1);
});

test("per-edition keys preserve another tab's unrelated edits and stale revisions cannot overwrite a manual change", () => {
  const { storage, store } = setup();
  store.save(metadata);
  const original = store.getSnapshot().entries[0]!;
  const other = setup(storage).store;
  other.save({ ...metadata, slug: "another" });
  assert.equal(store.update(identity, original.revision, { state: "reading" }).ok, true);
  store.refresh();
  assert.equal(store.getSnapshot().entries.length, 2);
  assert.equal(other.update(identity, original.revision, { state: "finished" }).ok, false);
  other.refresh();
  assert.equal(other.getSnapshot().entries.find(x => x.slug === "river")?.state, "reading");
});

test("position writes need current explicit consent and cannot resurrect removed/re-added editions", () => {
  const { store } = setup();store.save(metadata);
  const before = store.getSnapshot().entries[0]!;
  store.update(identity, before.revision, { tracking: true });
  const enabled = store.getSnapshot().entries[0]!;
  const position = captureReadingPosition([{ id: "p", text: "正在读的正文", top: 0, height: 400 }], 100, "v1")!;
  assert.equal(store.checkpoint(identity, enabled.tracking!, position).ok, true);
  const saved = store.getSnapshot().entries[0]!;
  assert.equal(saved.position?.blockId, "p");
  assert.equal(store.update(identity, saved.revision, { tracking: false }).ok, true);
  assert.equal(store.checkpoint(identity, enabled.tracking!, position).ok, false);
  const disabled = store.getSnapshot().entries[0]!;
  assert.equal(store.remove(identity, disabled.revision).ok, true);
  store.save(metadata);
  assert.equal(store.checkpoint(identity, enabled.tracking!, position).ok, false);
  assert.equal(store.getSnapshot().entries[0]?.position, null);
});

test("refused storage is never reported as saved, and deleting a shelf never clears notes, theme or auth", () => {
  const { storage, store } = setup();
  storage.denyWrites = true;
  assert.equal(store.save(metadata).ok, false);
  assert.equal(store.getSnapshot().entries.length, 0);
  storage.denyWrites = false;store.save(metadata);
  storage.setItem("nw-passages-v1:river", "reader notes");
  storage.setItem("nw-theme", "dark");
  assert.equal(store.clear(store.getSnapshot().stamp).ok, true);
  assert.equal(storage.getItem("nw-passages-v1:river"), "reader notes");
  assert.equal(storage.getItem("nw-theme"), "dark");
});

test("corrupt slots are visible as a warning, retained on read, and never silently overwritten", () => {
  const { storage, store } = setup();
  storage.setItem(SHELF_STORAGE_PREFIX + identity, "not-json");store.refresh();
  assert.equal(store.getSnapshot().invalid, 1);
  assert.equal(store.save(metadata).ok, false);
  assert.equal(storage.getItem(SHELF_STORAGE_PREFIX + identity), "not-json");
});

test("stale clear/import previews fail before writes, and a partial import reports the confirmed count", () => {
  const { storage, store } = setup();store.save(metadata);
  const record = store.getSnapshot().entries[0]!;
  const stamp = store.getSnapshot().stamp;
  const incoming = [{ ...record, slug: "second" }, { ...record, slug: "third" }];
  store.save({ ...metadata, slug: "another" });
  assert.equal(store.clear(stamp).ok, false);
  assert.equal(store.importRecords(incoming, "keep", stamp).ok, false);
  assert.equal(store.getSnapshot().entries.length, 2);
  storage.writesBeforeFailure = 1;
  const result = store.importRecords(incoming, "keep", store.getSnapshot().stamp);
  assert.equal(result.ok, false);
  assert.equal(result.applied, 1);
  assert.equal(store.getSnapshot().entries.length, 3);
  assert.ok(store.getSnapshot().entries.some(x => x.slug === "river"));
});

test("forgetting a position revokes old consent before a queued scroll can restore it", () => {
  const { store } = setup();store.save(metadata);
  store.update(identity, store.getSnapshot().entries[0]!.revision, { tracking: true });
  const enabled = store.getSnapshot().entries[0]!;
  const position = captureReadingPosition([{ id: "p", text: "正文", top: 0, height: 400 }], 100, "v1")!;
  store.checkpoint(identity, enabled.tracking!, position);
  store.update(identity, store.getSnapshot().entries[0]!.revision, { resetPosition: true });
  assert.equal(store.getSnapshot().entries[0]?.tracking, null);
  assert.equal(store.checkpoint(identity, enabled.tracking!, position).ok, false);
  assert.equal(store.getSnapshot().entries[0]?.position, null);
});

test("bulk changes preflight every selected revision; a later write failure reports only confirmed changes", () => {
  const { storage, store } = setup();store.save(metadata);store.save({ ...metadata, slug: "second" });
  const selection = store.getSnapshot().entries.map(entry => ({ identity: shelfIdentity(entry), revision: entry.revision }));
  store.update(identity, selection.find(x => x.identity === identity)!.revision, { state: "reading" });
  assert.equal(store.batch(selection, "finished").ok, false);
  assert.equal(store.getSnapshot().entries.find(x => x.slug === "second")?.state, "later");
  const fresh = store.getSnapshot().entries.map(entry => ({ identity: shelfIdentity(entry), revision: entry.revision }));
  storage.writesBeforeFailure = 1;
  const partial = store.batch(fresh, "finished");
  assert.equal(partial.ok, false);
  assert.equal(partial.applied, 1);
  assert.equal(store.getSnapshot().entries.filter(entry => entry.state === "finished").length, 1);
});
