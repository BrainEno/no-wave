import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { createWritingBackup, parseWritingBackup } from "./writing-backup.ts";
import {
  WritingRecoveryController,
  type RecoverySnapshot,
} from "./writing-recovery-controller.ts";
import { WritingRecoveryFault } from "./writing-recovery-model.ts";
import { IndexedWritingRecoveryStore } from "./writing-recovery-store.ts";
import type {
  RecoverySourceReview,
  WritingRecoverySourceReader,
} from "./writing-recovery-source.ts";

const now = 1_800_000_000_000;
const fault = (code: string) => (error: unknown) =>
  error instanceof WritingRecoveryFault && error.code === code;
function fixture(
  sourceReader?: Pick<WritingRecoverySourceReader, "read" | "cancel">,
) {
  const factory = new IDBFactory(),
    name = randomUUID();
  const store = new IndexedWritingRecoveryStore({
    factory: () => factory,
    name,
  });
  let actor = "author-a",
    lost = 0,
    probes = 0;
  const snapshot: RecoverySnapshot = {
    dirty: false,
    base: { articleId: null, locale: "zh-CN", revision: null },
    draft: {
      title: "",
      summary: "",
      locale: "zh-CN",
      workType: "essay",
      editorState: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [{ type: "text", version: 1, text: "未保存正文" }],
            },
          ],
        },
      },
    },
  };
  let probe: (() => Promise<string>) | null = null;
  const controller = new WritingRecoveryController({
    store,
    sourceReader,
    actor: async () => {
      probes++;
      return probe ? probe() : actor;
    },
    snapshot: () => structuredClone(snapshot),
    now: () => now,
    delayMs: 10000,
    identityLost: () => {
      lost++;
    },
  });
  return {
    controller,
    store,
    snapshot,
    get probes() {
      return probes;
    },
    get lost() {
      return lost;
    },
    setActor: (value: string) => {
      actor = value;
    },
    setProbe: (value: (() => Promise<string>) | null) => {
      probe = value;
    },
  };
}

test("default-off controller verifies a live account but never persists typed content until explicit consent", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  f.snapshot.draft.title = "只在内存";
  f.snapshot.dirty = true;
  f.controller.noteChange();
  assert.equal(await f.controller.flush(), false);
  assert.equal(f.controller.getSnapshot().status, "off");
  assert.equal(await f.store.inspect(), null);
  await f.controller.enable();
  await f.controller.flush();
  const state = f.controller.getSnapshot();
  assert.equal(state.status, "ready");
  assert.equal(state.entries.length, 1);
  assert.equal(
    parseWritingBackup(state.entries[0]!.backup).draft.title,
    "只在内存",
  );
  assert.equal(
    f.snapshot.draft.title,
    "只在内存",
    "caching is not server acknowledgement or editor mutation",
  );
});

test("late identity from before disable cannot re-enable consent, and changing accounts hides old cache and revokes the old lease", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  f.snapshot.dirty = true;
  f.controller.noteChange();
  await f.controller.flush();
  let release!: (value: string) => void;
  f.setProbe(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = f.controller.connect("author-a");
  for (let n = 0; n < 30 && !release; n++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  f.controller.suspend();
  await f.store.purge();
  release("author-a");
  await pending;
  assert.equal(f.controller.getSnapshot().entries.length, 0);
  f.setProbe(null);
  f.setActor("author-b");
  await f.controller.connect("author-a");
  assert.equal(f.controller.getSnapshot().actor, null);
  assert.ok(f.lost >= 1);
  assert.equal(
    (await f.store.attach("author-b", await f.store.inspect())).entries.length,
    0,
  );
});

test("latest edits coalesce without losing the revision returned by an in-flight transaction", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  f.snapshot.dirty = true;
  f.snapshot.draft.title = "提交开始";
  f.controller.noteChange();
  let release!: () => void, entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.store.put.bind(f.store);
  let once = true;
  f.store.put = async (...args) => {
    if (once) {
      once = false;
      entered();
      await gate;
    }
    return original(...args);
  };
  const flush = f.controller.flush();
  await arrived;
  f.snapshot.draft.summary = "落盘途中继续输入";
  f.controller.noteChange();
  release();
  await flush;
  await f.controller.flush();
  const rows = f.controller.getSnapshot().entries;
  assert.equal(rows.length, 1);
  assert.equal(
    parseWritingBackup(rows[0]!.backup).draft.summary,
    "落盘途中继续输入",
  );
});

test("a server write first checkpoints outcome-unknown; only explicit confirmation can settle it, and later edits remain cached", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  f.snapshot.dirty = true;
  await f.controller.beforeServerWrite();
  assert.equal(f.controller.getSnapshot().entries[0]!.outcomeUnknown, true);
  f.snapshot.draft.title = "响应途中又改了标题";
  f.controller.noteChange();
  await f.controller.flush();
  assert.equal(f.controller.getSnapshot().entries[0]!.outcomeUnknown, true);
  await f.controller.confirmServerWrite();
  assert.equal(f.controller.getSnapshot().entries[0]!.outcomeUnknown, false);
  assert.equal(
    parseWritingBackup(f.controller.getSnapshot().entries[0]!.backup).draft
      .title,
    "响应途中又改了标题",
  );
  f.snapshot.dirty = false;
  f.controller.noteChange();
  await f.controller.flush();
  assert.equal(f.controller.getSnapshot().entries.length, 0);
});

test("restore re-verifies the exact persisted candidate and current target; ambiguous outcomes block new server writes until a person reviews", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  const view = await f.store.attach("author-a", await f.store.inspect());
  const source = { ...f.snapshot.draft, title: "恢复来源" };
  const row = await f.store.put(
    view.lease!,
    {
      id: randomUUID(),
      writer: randomUUID(),
      expectedRevision: null,
      base: f.snapshot.base,
      outcomeUnknown: true,
      backup: createWritingBackup(source, new Date(now)),
    },
    now,
  );
  await f.controller.preview(row.id);
  const restored = await f.controller.restore(["title"], {
    differentBase: true,
    remoteImages: false,
  });
  assert.equal(restored?.title, "恢复来源");
  assert.equal(f.controller.getSnapshot().requiresReview, true);
  Object.assign(f.snapshot.draft, restored);
  f.snapshot.dirty = true;
  f.controller.noteChange();
  await f.controller.flush();
  await assert.rejects(
    f.controller.beforeServerWrite(),
    fault("review_required"),
  );
  await f.controller.acknowledgeReview();
  assert.equal(f.controller.getSnapshot().requiresReview, false);
  await f.controller.beforeServerWrite();
  const untouched = (await f.store.read(view.lease!)).find(
    (entry) => entry.id === row.id,
  )!;
  assert.equal(
    untouched.outcomeUnknown,
    true,
    "copy recovery cannot settle the original tab's request",
  );
});

test("a revoked editor cannot acquire a fresh epoch through explicit enable or a late account probe", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  f.controller.invalidate();
  await f.store.purge();
  await f.controller.connect("author-a");
  await f.controller.enable();
  assert.equal(f.controller.getSnapshot().status, "revoked");
  await assert.rejects(f.controller.beforeServerWrite(), fault("revoked"));
  assert.equal(
    (await f.store.attach("author-a", await f.store.inspect())).lease,
    null,
  );
});

test("stale cache revisions, changed input and changed target each refuse a previously displayed preview", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  const view = await f.store.attach("author-a", await f.store.inspect());
  const input = {
    id: randomUUID(),
    writer: randomUUID(),
    expectedRevision: null,
    base: f.snapshot.base,
    outcomeUnknown: false,
    backup: createWritingBackup(
      { ...f.snapshot.draft, title: "旧预览" },
      new Date(now),
    ),
  };
  let row = await f.store.put(view.lease!, input, now);
  await f.controller.preview(row.id);
  row = await f.store.put(
    view.lease!,
    {
      ...input,
      expectedRevision: row.revision,
      backup: createWritingBackup(
        { ...f.snapshot.draft, title: "较新来源" },
        new Date(now),
      ),
    },
    now,
  );
  assert.equal(
    await f.controller.restore(["title"], {
      differentBase: true,
      remoteImages: false,
    }),
    null,
  );
  await f.controller.preview(row.id);
  f.snapshot.draft.summary = "预览后的输入";
  assert.equal(
    await f.controller.restore(["title"], {
      differentBase: true,
      remoteImages: false,
    }),
    null,
  );
  await f.controller.preview(row.id);
  f.snapshot.base.articleId = randomUUID();
  assert.equal(
    await f.controller.restore(["title"], {
      differentBase: true,
      remoteImages: false,
    }),
    null,
  );
  assert.equal(f.snapshot.draft.title, "");
});

test("quota failure never says cached, never automatically retries, and blocks a new request that lacks its durable checkpoint", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  f.store.put = () => Promise.reject(new WritingRecoveryFault("quota"));
  f.snapshot.dirty = true;
  f.controller.noteChange();
  assert.equal(await f.controller.flush(), false);
  assert.match(f.controller.getSnapshot().error, /空间不足/);
  assert.equal(f.controller.getSnapshot().savedAt, null);
  await assert.rejects(f.controller.beforeServerWrite(), fault("quota"));
  assert.equal(f.snapshot.draft.editorState!.root.children.length, 1);
});

test("successful caching after a failed preview rereads the complete list instead of hiding retained branches", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  const view = await f.store.attach("author-a", await f.store.inspect());
  const row = await f.store.put(
    view.lease!,
    {
      id: randomUUID(),
      writer: randomUUID(),
      expectedRevision: null,
      base: f.snapshot.base,
      outcomeUnknown: false,
      backup: createWritingBackup(
        { ...f.snapshot.draft, title: "必须继续可见的旧稿" },
        new Date(now),
      ),
    },
    now,
  );
  await f.controller.preview(randomUUID());
  assert.equal(f.controller.getSnapshot().entries.length, 0);
  f.snapshot.dirty = true;
  f.snapshot.draft.title = "错误后继续写的新稿";
  f.controller.noteChange();
  await f.controller.flush();
  assert.equal(f.controller.getSnapshot().entries.length, 2);
  assert.ok(
    f.controller.getSnapshot().entries.some((entry) => entry.id === row.id),
  );
});

test("explicit device-wide deletion remains possible offline and never claims success when the purge fails", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  f.snapshot.dirty = true;
  f.controller.noteChange();
  await f.controller.flush();
  f.setProbe(() => Promise.reject(new Error("offline")));
  await f.controller.disable();
  assert.equal(f.controller.getSnapshot().status, "off");
  assert.equal(
    (await f.store.attach("author-a", await f.store.inspect())).entries.length,
    0,
  );
  f.store.purge = () => Promise.reject(new WritingRecoveryFault("unavailable"));
  await f.controller.disable();
  assert.equal(f.controller.getSnapshot().status, "error");
  assert.match(f.controller.getSnapshot().error, /浏览器拒绝/);
});

test("a server write waits for the initial consent lookup instead of racing a previous visit's enabled cache", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.store.enable("author-a", await f.store.inspect());
  let release!: (actor: string) => void;
  f.setProbe(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const connecting = f.controller.connect("author-a");
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  f.snapshot.dirty = true;
  let finished = false;
  const checkpoint = f.controller.beforeServerWrite().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, false);
  f.setProbe(null);
  release("author-a");
  await connecting;
  await checkpoint;
  assert.equal(f.controller.getSnapshot().entries[0]!.outcomeUnknown, true);
});

test("source review is read-only and discards a late result after the persisted candidate changes or the editor is suspended", async (t) => {
  let release!: (value: RecoverySourceReview) => void,
    captured!: RecoverySourceReview;
  const f = fixture({
    cancel: () => {},
    read: async (row, actor) => {
      assert.equal(actor, "author-a");
      captured = {
        id: row.id,
        witness: JSON.stringify(row),
        kind: "available",
        relation: "same",
        serverRevision: "1",
        serverStatus: "draft",
        equivalent: true,
        comparison: null,
        checkedAt: now,
      };
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  await f.controller.enable();
  const view = await f.store.attach("author-a", await f.store.inspect());
  const input = {
    id: randomUUID(),
    writer: randomUUID(),
    expectedRevision: null,
    base: { articleId: randomUUID(), locale: "zh-CN", revision: "1" },
    outcomeUnknown: true,
    backup: createWritingBackup(f.snapshot.draft, new Date(now)),
  };
  let row = await f.store.put(view.lease!, input, now);
  const first = f.controller.reviewSource(row.id);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  release(captured);
  await first;
  assert.equal(f.controller.getSnapshot().sourceReview?.equivalent, true);
  assert.equal((await f.store.read(view.lease!))[0]!.outcomeUnknown, true);
  release = undefined!;
  const changed = f.controller.reviewSource(row.id);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  row = await f.store.put(
    view.lease!,
    { ...input, expectedRevision: row.revision },
    now,
  );
  release(captured);
  await changed;
  assert.equal(f.controller.getSnapshot().sourceReview, null);
  assert.match(f.controller.getSnapshot().sourceError, /变化|过期/);
  release = undefined!;
  const hidden = f.controller.reviewSource(row.id);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  f.controller.suspend();
  release(captured);
  await hidden;
  assert.equal(f.controller.getSnapshot().sourceReview, null);
  assert.equal(f.snapshot.draft.title, "");
});

test("passive lifecycle of an unchanged default-off namespace reads metadata only; explicit reads and changed consent still prove the live actor", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  assert.equal(f.probes, 1);
  f.controller.suspend();
  await f.controller.connect("author-a", "lifecycle");
  assert.equal(
    f.probes,
    1,
    "no manuscript or lease may be exposed by the metadata-only fast path",
  );
  assert.equal(f.controller.getSnapshot().actor, null);
  assert.equal(f.controller.getSnapshot().status, "off");
  assert.deepEqual(f.controller.getSnapshot().entries, []);
  assert.equal(await f.controller.flush(), false);
  await f.controller.connect("author-a");
  assert.equal(
    f.probes,
    2,
    "an explicit account/list refresh is never a cached identity proof",
  );
  const view = await f.store.enable("author-a", await f.store.inspect());
  await f.store.put(
    view.lease!,
    {
      id: randomUUID(),
      writer: randomUUID(),
      expectedRevision: null,
      base: f.snapshot.base,
      backup: createWritingBackup(f.snapshot.draft, new Date(now)),
      outcomeUnknown: false,
    },
    now,
  );
  f.controller.suspend();
  await f.controller.connect("author-a", "lifecycle");
  assert.equal(
    f.probes,
    3,
    "new consent invalidates the off witness before any manuscript is read",
  );
  assert.equal(f.controller.getSnapshot().entries.length, 1);
  f.controller.suspend();
  f.setActor("author-b");
  await f.controller.connect("author-a", "lifecycle");
  assert.equal(
    f.probes,
    4,
    "enabled namespaces always require a live identity, even with an unchanged epoch",
  );
  assert.equal(f.controller.getSnapshot().status, "revoked");
  assert.deepEqual(f.controller.getSnapshot().entries, []);
  assert.ok(f.lost > 0);
});

test("an off metadata witness cannot authorize opt-in after a silent account switch", async (t) => {
  const f = fixture();
  t.after(() => {
    f.controller.dispose();
    f.store.close();
  });
  await f.controller.connect("author-a");
  f.controller.suspend();
  f.setActor("author-b");
  await f.controller.connect("author-a", "lifecycle");
  assert.equal(f.probes, 1);
  assert.equal(f.controller.getSnapshot().status, "off");
  await f.controller.enable();
  assert.equal(f.probes, 2);
  assert.equal(f.controller.getSnapshot().status, "revoked");
  assert.deepEqual(f.controller.getSnapshot().entries, []);
  assert.equal(await f.controller.flush(), false);
});
