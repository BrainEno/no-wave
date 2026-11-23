import assert from "node:assert/strict";
import test from "node:test";
import { createShelfActions, type ShelfExclusive } from "./reading-shelf-actions.ts";
import { createReadingShelfStore, type ShelfStorage } from "./reading-shelf-store.ts";
import { shelfIdentity, type ShelfMetadata } from "./reading-shelf.ts";

class MemoryStorage implements ShelfStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const metadata: ShelfMetadata = { slug: "river", locale: "en", title: "River", author: "A", workType: "other" };

function exclusiveQueue(): ShelfExclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return (work, signal) => {
    const next = tail.then(() => {
      if (signal.aborted) throw new DOMException("cancelled", "AbortError");
      return work();
    });
    tail = next.catch(() => {});
    return next;
  };
}
function setup(storage = new MemoryStorage()) {
  let nonce = 0;
  const store = createReadingShelfStore({ now: () => 2000, nonce: () => `token-${++nonce}` });
  store.connect(storage);
  return { storage, store, actions: createShelfActions(store) };
}

test("writes require an active exclusive browser coordinator; reads remain available", async () => {
  const { actions, store } = setup();
  assert.equal(actions.getServerSnapshot().writable, false);
  assert.deepEqual(await actions.save(metadata), { ok: false, code: "unsupported", applied: 0 });
  assert.equal(store.getSnapshot().status, "ready");
  assert.equal(store.getSnapshot().entries.length, 0);
  actions.connect(exclusiveQueue());
  assert.equal(actions.getSnapshot().writable, true);
  assert.equal((await actions.save(metadata)).ok, true);
  assert.equal(store.getSnapshot().entries.length, 1);
  actions.disconnect();
  assert.equal((await actions.save({ ...metadata, slug: "another" })).ok, false);
  assert.equal(store.getSnapshot().entries.length, 1);
});

test("two tabs serialize the whole read/compare/write, so stale revisions cannot win a race", async () => {
  const first = setup();
  const second = setup(first.storage);
  const lock = exclusiveQueue();
  first.actions.connect(lock);second.actions.connect(lock);
  await first.actions.save(metadata);
  const record = first.store.getSnapshot().entries[0]!;
  const identity = shelfIdentity(record);
  const attempts = await Promise.all([
    first.actions.update(identity, record.revision, { state: "reading" }),
    second.actions.update(identity, record.revision, { state: "finished" }),
    second.actions.save({ ...metadata, slug: "another" }),
  ]);
  assert.equal(attempts[0]!.ok, true);
  assert.deepEqual(attempts[1], { ok: false, code: "changed", applied: 0 });
  assert.equal(attempts[2]!.ok, true);
  first.store.refresh();
  assert.equal(first.store.getSnapshot().entries.find(row => row.slug === "river")?.state, "reading");
  assert.equal(first.store.getSnapshot().entries.length, 2);
  assert.equal(first.actions.getSnapshot().pending, 0);
  assert.equal(second.actions.getSnapshot().pending, 0);
});

test("disconnect revokes queued work and reconnect cannot revive an old consent or pending write", async () => {
  const { actions, store } = setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  actions.connect(async (work, signal) => { await gate; return signal.aborted ? { ok: false, code: "unavailable", applied: 0 } : work(); });
  const pending = actions.save(metadata);
  assert.equal(actions.getSnapshot().pending, 1);
  actions.disconnect();
  actions.connect(exclusiveQueue());
  release();
  assert.equal((await pending).ok, false);
  assert.equal(store.getSnapshot().entries.length, 0);
  assert.equal(actions.getSnapshot().pending, 0);
  assert.equal((await actions.save(metadata)).ok, true);
});

test("rejected lock requests are explicit failures, and a confirmed partial result is preserved", async () => {
  const { actions } = setup();
  actions.connect(async () => { throw new Error("lock refused"); });
  assert.deepEqual(await actions.save(metadata), { ok: false, code: "unavailable", applied: 0 });
  assert.equal(actions.getSnapshot().pending, 0);
  actions.connect(async () => ({ ok: false, code: "quota", applied: 2 }));
  assert.deepEqual(await actions.save(metadata), { ok: false, code: "quota", applied: 2 });
  assert.equal(actions.getSnapshot().pending, 0);
});
