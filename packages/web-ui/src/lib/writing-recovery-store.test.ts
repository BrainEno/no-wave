import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBObjectStore, IDBDatabase } from "fake-indexeddb";
import { randomUUID } from "node:crypto";
import { createWritingBackup } from "./writing-backup.ts";
import {
  RECOVERY_LIMITS,
  recoverySize,
  WritingRecoveryFault,
  type RecoveryInput,
  type RecoveryLease,
} from "./writing-recovery-model.ts";
import { IndexedWritingRecoveryStore } from "./writing-recovery-store.ts";

const now = 1_800_000_000_000;
const fault = (code: string) => (error: unknown) =>
  error instanceof WritingRecoveryFault && error.code === code;
function fixture() {
  const factory = new IDBFactory(),
    name = randomUUID();
  const store = new IndexedWritingRecoveryStore({
    factory: () => factory,
    name,
  });
  const peer = new IndexedWritingRecoveryStore({
    factory: () => factory,
    name,
  });
  return { store, peer, factory, name };
}
function input(text = "不会自动发布的文稿"): RecoveryInput {
  return {
    id: randomUUID(),
    writer: randomUUID(),
    expectedRevision: null,
    base: { articleId: null, locale: "zh-CN", revision: null },
    outcomeUnknown: false,
    backup: createWritingBackup(
      {
        title: "海风",
        summary: "",
        locale: "zh-CN",
        workType: "other",
        editorState: {
          root: {
            type: "root",
            version: 1,
            children: [
              {
                type: "paragraph",
                version: 1,
                children: [{ type: "text", version: 1, text }],
              },
            ],
          },
        },
      },
      new Date(now),
    ),
  };
}
async function enabled(store: IndexedWritingRecoveryStore) {
  const state = await store.enable("author-a", await store.inspect());
  assert.ok(state.lease);
  return state.lease;
}

test("default attach is off and stores no manuscript; explicit enable survives a new connection without accepting the database as login proof", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  assert.deepEqual(await f.store.attach("author-a", await f.store.inspect()), {
    control: null,
    lease: null,
    entries: [],
  });
  const lease = await enabled(f.store),
    row = await f.store.put(lease, input(), now);
  const restored = await f.peer.attach("author-a", await f.peer.inspect());
  assert.deepEqual(restored.lease, lease);
  assert.equal(restored.entries[0]!.backup, row.backup);
  const switched = await f.peer.attach("author-b", await f.peer.inspect());
  assert.equal(switched.lease, null);
  assert.deepEqual(switched.entries, []);
  await assert.rejects(f.store.read(lease), fault("revoked"));
});

test("concurrent tabs preserve distinct branches and compare-and-swap prevents stale overwrite or stale delete", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  const a = input("窗口一"),
    b = input("窗口二");
  const [first, second] = await Promise.all([
    f.store.put(lease, a, now),
    f.peer.put(lease, b, now),
  ]);
  assert.notEqual(first.revision, second.revision);
  assert.equal((await f.store.read(lease)).length, 2);
  const changed = await f.store.put(
    lease,
    { ...a, expectedRevision: first.revision },
    now,
  );
  await assert.rejects(
    f.peer.put(lease, { ...a, expectedRevision: first.revision }, now),
    fault("conflict"),
  );
  await assert.rejects(
    f.peer.put(
      lease,
      { ...a, expectedRevision: changed.revision, writer: b.writer },
      now,
    ),
    fault("conflict"),
  );
  await assert.rejects(
    f.peer.remove(lease, a.id, first.revision),
    fault("conflict"),
  );
  assert.equal((await f.store.read(lease)).length, 2);
  await f.store.remove(lease, a.id, changed.revision);
  const reincarnated = await f.store.put(lease, a, now);
  assert.ok(
    reincarnated.revision > changed.revision,
    "deletion must not reset the generation and revive old preview witnesses",
  );
});

test("purge is an atomic revocation: queued old writes and old identity proofs cannot resurrect drafts or consent", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  await f.store.put(lease, input(), now);
  const proofStarted = await f.peer.inspect();
  await f.store.purge();
  await assert.rejects(
    f.peer.enable("author-a", proofStarted),
    fault("revoked"),
  );
  await assert.rejects(f.peer.put(lease, input(), now), fault("revoked"));
  const after = await f.peer.attach("author-a", await f.peer.inspect());
  assert.equal(after.lease, null);
  assert.equal(after.entries.length, 0);
  const next = await enabled(f.peer);
  assert.notEqual(next.epoch, lease.epoch);
});

test("a quota failure at the final IDB put rolls back the entire write and does not report request success as transaction commit", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store),
    row = input();
  const prior = await f.store.put(lease, row, now);
  const put = IDBObjectStore.prototype.put;
  const mock = t.mock.method(
    IDBObjectStore.prototype,
    "put",
    function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      if (this.name === "drafts")
        throw new DOMException("injected", "QuotaExceededError");
      return put.apply(this, args);
    },
  );
  await assert.rejects(
    f.store.put(
      lease,
      { ...row, expectedRevision: prior.revision, outcomeUnknown: true },
      now,
    ),
    fault("quota"),
  );
  mock.mock.restore();
  const unchanged = await f.peer.read(lease);
  assert.deepEqual(unchanged, [prior]);
  const next = await f.store.put(
    lease,
    { ...row, expectedRevision: prior.revision },
    now,
  );
  assert.equal(
    next.revision,
    prior.revision + 1,
    "the control serial must roll back too",
  );
});

test("record budget admission is serialized with writes; no silent oldest-draft eviction", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  await Promise.all(
    Array.from({ length: 20 }, () => f.store.put(lease, input(), now)),
  );
  await assert.rejects(f.peer.put(lease, input(), now), fault("limit"));
  assert.equal((await f.store.read(lease)).length, 20);
  const rows = await f.store.read(lease);
  await f.store.remove(lease, rows[0]!.id, rows[0]!.revision);
  assert.ok(await f.peer.put(lease, input(), now));
});

test("clock rollback and malformed stored records fail closed; deliberate purge still works", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease: RecoveryLease = await enabled(f.store);
  const row = input();
  await f.store.put(lease, row, now);
  await assert.rejects(f.store.put(lease, input(), now - 1), fault("clock"));
  const request = f.factory.open(f.name, 1);
  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = raw.transaction("drafts", "readwrite");
  transaction
    .objectStore("drafts")
    .put({ id: randomUUID(), token: "synthetic-invalid-field" });
  await new Promise<void>((resolve) => {
    transaction.oncomplete = () => resolve();
  });
  raw.close();
  await assert.rejects(f.store.read(lease), fault("invalid"));
  await f.store.purge();
  assert.equal(
    (await f.store.attach("author-a", await f.store.inspect())).entries.length,
    0,
  );
});

async function rawDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  const request = factory.open(name, 1);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("aggregate UTF-8 bytes, not character count, bound cache admission without evicting a prior branch", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  const large = input("海".repeat(400_000));
  const first = await f.store.put(lease, large, now),
    size = recoverySize(first);
  const count = Math.floor(RECOVERY_LIMITS.bytes / size);
  for (let index = 1; index < count - 1; index++)
    await f.store.put(
      lease,
      { ...large, id: randomUUID(), writer: randomUUID() },
      now,
    );
  const last = await Promise.allSettled([
    f.store.put(
      lease,
      { ...large, id: randomUUID(), writer: randomUUID() },
      now,
    ),
    f.peer.put(
      lease,
      { ...large, id: randomUUID(), writer: randomUUID() },
      now,
    ),
  ]);
  assert.equal(
    last.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failed = last.find((result) => result.status === "rejected");
  assert.ok(
    failed && failed.status === "rejected" && fault("limit")(failed.reason),
  );
  const rows = await f.store.read(lease);
  assert.equal(rows.length, count);
  assert.ok(rows.some((row) => row.id === first.id));
  assert.ok(
    rows.reduce((bytes, row) => bytes + recoverySize(row), 0) <=
      RECOVERY_LIMITS.bytes,
  );
});

test("exhausted serial cannot wrap, delete a prior row or clear an ambiguous request outcome", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  const original = input(),
    row = await f.store.put(lease, { ...original, outcomeUnknown: true }, now);
  const raw = await rawDatabase(f.factory, f.name);
  const tx = raw.transaction("control", "readwrite"),
    metadata = tx.objectStore("control").get("active");
  metadata.onsuccess = () => {
    tx.objectStore("control").put(
      { ...metadata.result, serial: Number.MAX_SAFE_INTEGER },
      "active",
    );
  };
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  raw.close();
  await assert.rejects(
    f.store.put(lease, { ...original, expectedRevision: row.revision }, now),
    fault("limit"),
  );
  await assert.rejects(
    f.store.remove(lease, row.id, row.revision),
    fault("limit"),
  );
  await assert.rejects(
    f.store.settle(lease, row.id, row.writer, row.revision),
    fault("limit"),
  );
  assert.deepEqual(await f.peer.read(lease), [row]);
  await f.store.purge();
  assert.equal(
    (await f.store.attach("author-a", await f.store.inspect())).lease,
    null,
  );
});

test("settlement requires the exact writer and revision, stays sticky on ordinary puts and does not reset the global serial", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store),
    source = input();
  const row = await f.store.put(
    lease,
    { ...source, outcomeUnknown: true },
    now,
  );
  const next = await f.peer.put(
    lease,
    { ...source, expectedRevision: row.revision, outcomeUnknown: false },
    now,
  );
  assert.equal(next.outcomeUnknown, true);
  await assert.rejects(
    f.store.settle(lease, row.id, row.writer, row.revision),
    fault("conflict"),
  );
  await assert.rejects(
    f.store.settle(lease, next.id, randomUUID(), next.revision),
    fault("conflict"),
  );
  const settled = await f.store.settle(
    lease,
    next.id,
    next.writer,
    next.revision,
  );
  assert.equal(settled.outcomeUnknown, false);
  assert.ok(settled.revision > next.revision);
  const witness = await f.store.inspect();
  await f.peer.revoke(witness);
  await assert.rejects(f.store.revoke(witness), fault("revoked"));
  await assert.rejects(
    f.store.settle(lease, settled.id, settled.writer, settled.revision),
    fault("revoked"),
  );
});

test("unavailable, blocked and stalled opens have bounded distinct failures, including a safely closed late success", async (t) => {
  const denied = new IndexedWritingRecoveryStore({
    factory: () => {
      throw new DOMException("disabled", "SecurityError");
    },
  });
  await assert.rejects(denied.inspect(), fault("unavailable"));
  denied.close();
  const factory = new IDBFactory();
  // A deliberately controllable browser-request boundary; no real timers or
  // persistence are mocked in the normal transaction/concurrency tests above.
  const request = new EventTarget() as IDBOpenDBRequest;
  t.mock.method(factory, "open", () => request);
  const stalled = new IndexedWritingRecoveryStore({
    factory: () => factory,
    timeoutMs: 15,
  });
  await assert.rejects(stalled.inspect(), fault("timeout"));
  let closed = 0;
  Object.defineProperty(request, "result", {
    value: {
      close: () => {
        closed++;
      },
    },
  });
  request.onsuccess?.call(request, new Event("success"));
  assert.equal(closed, 1);
  stalled.close();
  const blocked = new IndexedWritingRecoveryStore({
    factory: () => factory,
    timeoutMs: 100,
  });
  const waiting = blocked.inspect();
  request.onblocked?.call(
    request,
    new Event("blocked") as IDBVersionChangeEvent,
  );
  await assert.rejects(waiting, fault("blocked"));
  blocked.close();
});

test("a stalled transaction times out and aborts instead of claiming a committed write", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  const slow = new IndexedWritingRecoveryStore({
    factory: () => f.factory,
    name: f.name,
    timeoutMs: 20,
  });
  t.after(() => slow.close());
  await slow.inspect();
  const original = IDBDatabase.prototype.transaction;
  const mock = t.mock.method(
    IDBDatabase.prototype,
    "transaction",
    function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      const tx = original.apply(this, args);
      const keepAlive = () => {
        const request = tx.objectStore("control").get("active");
        request.onsuccess = keepAlive;
      };
      keepAlive();
      return tx;
    },
  );
  await assert.rejects(slow.put(lease, input(), now), fault("timeout"));
  mock.mock.restore();
  assert.deepEqual(await f.peer.read(lease), []);
});

test("request success followed by transaction abort is never reported as durable cache success", async (t) => {
  const f = fixture();
  t.after(() => {
    f.store.close();
    f.peer.close();
  });
  const lease = await enabled(f.store);
  const first = await f.store.put(lease, input(), now);
  const put = IDBObjectStore.prototype.put;
  const mock = t.mock.method(
    IDBObjectStore.prototype,
    "put",
    function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      const request = put.apply(this, args);
      if (this.name === "drafts")
        request.addEventListener("success", () => this.transaction.abort());
      return request;
    },
  );
  await assert.rejects(f.store.put(lease, input(), now), fault("unavailable"));
  mock.mock.restore();
  assert.deepEqual(await f.peer.read(lease), [first]);
});

test("closing an owner cancels a pending open and closes its late handle instead of leaking a live connection", async (t) => {
  const factory = new IDBFactory(),
    request = new EventTarget() as IDBOpenDBRequest;
  t.mock.method(factory, "open", () => request);
  let closed = 0;
  Object.defineProperty(request, "result", {
    value: {
      objectStoreNames: { length: 2, contains: () => true },
      close: () => {
        closed++;
      },
    },
  });
  const store = new IndexedWritingRecoveryStore({
    factory: () => factory,
    timeoutMs: 100,
  });
  const opening = store.inspect();
  store.close();
  request.onsuccess?.call(request, new Event("success"));
  await assert.rejects(opening, fault("unavailable"));
  assert.equal(closed, 1);
});
