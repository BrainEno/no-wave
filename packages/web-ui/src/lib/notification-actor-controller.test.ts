import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationController } from "./notification-controller.ts";
import { NotificationRequestError, type NotificationTransport } from "./notification-transport.ts";
import { notificationCursor, type NotificationPage } from "./notification-pages.ts";
import type { NotificationItem } from "./chrome.ts";

const ORIGINAL = "notification-original-reader";
const REPLACEMENT = "notification-replacement-reader";
function notices(count: number, prefix: string): NotificationItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-0000-4000-8000-${(count - index).toString(16).padStart(12, "0")}`,
    eventKey: `${prefix}-${index}`, payload: JSON.stringify({ type: "user.followed", followerId: prefix }),
    createdAt: "2026-11-01T00:00:00.000Z", readAt: null,
  }));
}
const pageOf = (items: NotificationItem[]): NotificationPage => ({ items, nextCursor: items.length === 50 ? notificationCursor(items.at(-1)!) : null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(count = 3) {
  const accounts = new Map([[ORIGINAL, notices(count, "10000000")], [REPLACEMENT, notices(2, "20000000")]]);
  let active = ORIGINAL;
  const calls: { kind: "actor" | "count" | "page" | "mark"; actor?: string; cursor?: string | null; id?: string; signal: AbortSignal }[] = [];
  function owned(actor: string): NotificationItem[] {
    if (actor !== undefined && actor !== active) throw new NotificationRequestError("account-changed");
    return accounts.get(active)!;
  }
  const transport: NotificationTransport = {
    async actor(signal) { calls.push({ kind: "actor", signal }); return active; },
    async count(signal, actor) { calls.push({ kind: "count", actor, signal }); return owned(actor).filter((item) => item.readAt === null).length; },
    async page(cursor, signal, actor) {
      calls.push({ kind: "page", actor, cursor, signal });
      const rows = owned(actor);
      const start = cursor ? rows.findIndex((item) => notificationCursor(item) === cursor) + 1 : 0;
      return pageOf(rows.slice(start, start + 50).map((item) => ({ ...item })));
    },
    async mark(id, signal, actor) {
      calls.push({ kind: "mark", actor, id, signal });
      const rows = owned(actor);
      const unread = rows.filter((row) => row.readAt === null && (id === undefined || row.id === id));
      for (const row of unread) row.readAt = "2026-11-02T00:00:00.000Z";
      return id === undefined ? unread.length : { ...rows.find((row) => row.id === id)! };
    },
  };
  const controller = createNotificationController(transport);
  return { controller, transport, calls, accounts, select: (actor: string) => { active = actor; } };
}
async function ready(count = 3) {
  const f = fixture(count);
  await f.controller.connect(true);
  await f.controller.refresh();
  return f;
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test("a session hint must resolve a verified recipient before even the badge-only request", async () => {
  const f = fixture();
  assert.equal(f.controller.getSnapshot().actorId, null);
  await f.controller.connect(true);
  assert.deepEqual(f.calls.map(({ kind, actor }) => [kind, actor]), [["actor", undefined], ["count", ORIGINAL]]);
  assert.equal(f.controller.getSnapshot().actorId, ORIGINAL);
  assert.equal(f.controller.getSnapshot().unread, 3);
  assert.equal(f.controller.getSnapshot().loaded, false);
  assert.equal(f.controller.getServerSnapshot().actorId, null);
});

test("the shared feed and authoritative total belong to exactly the same verified recipient", async () => {
  const f = await ready();
  const reads = f.calls.filter((call) => call.kind !== "actor");
  assert.ok(reads.length >= 3);
  assert.ok(reads.every((call) => call.actor === ORIGINAL));
  assert.equal(f.calls.filter((call) => call.kind === "actor").length, 1);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.actorId, ORIGINAL);
  assert.equal(snapshot.items[0]!.item.id, f.accounts.get(ORIGINAL)![0]!.id);
  assert.equal(snapshot.unread, 3);
});

test("identity verification is not a window in which a mark-all may acquire a different recipient", async () => {
  const f = fixture();
  const identified = deferred<string>(), entered = deferred<void>();
  f.transport.actor = async () => { entered.resolve(); return identified.promise; };
  const connecting = f.controller.connect(true);
  await entered.promise;
  assert.equal(f.controller.getSnapshot().actorId, null);
  assert.equal(f.controller.getSnapshot().unread, null);
  await f.controller.markRead();
  assert.equal(f.calls.length, 0);
  identified.resolve(ORIGINAL);
  await connecting;
  assert.deepEqual(f.calls.map(({ kind, actor }) => [kind, actor]), [["count", ORIGINAL]]);
  assert.equal(f.controller.getSnapshot().pending, null);
});

test("a failed initial identity cannot fall back to unbound notification reads or writes", async () => {
  const f = fixture();
  let attempts = 0;
  f.transport.actor = async () => { attempts++; throw new NotificationRequestError("unavailable"); };
  await f.controller.connect(true);
  await f.controller.markRead();
  await f.controller.loadMore();
  assert.equal(attempts, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getSnapshot().actorId, null);
  assert.equal(f.controller.getSnapshot().error, "unavailable");
  assert.equal(f.controller.getSnapshot().unread, null);
  f.transport.actor = async () => { attempts++; return ORIGINAL; };
  await f.controller.refresh();
  assert.equal(attempts, 2);
  assert.equal(f.controller.getSnapshot().items.length, 3);
  assert.ok(f.calls.every((call) => call.actor === ORIGINAL));
});

test("an invalid verified-identity shape is refused before a private operation", async () => {
  for (const actor of ["", " padded", "x".repeat(301), "reader\u0000id", "\ud800"]) {
    const f = fixture();
    f.transport.actor = async () => actor;
    await f.controller.connect(true);
    assert.equal(f.controller.getSnapshot().actorId, null, JSON.stringify(actor));
    assert.equal(f.controller.getSnapshot().error, "invalid-response");
    assert.equal(f.calls.length, 0);
  }
});

test("a cookie replacement cannot transfer a stale mark-all to the replacement inbox", async () => {
  const f = await ready();
  f.select(REPLACEMENT);
  await f.controller.markRead();
  const state = f.controller.getSnapshot();
  assert.equal(state.error, "account-changed");
  assert.equal(state.actorId, null);
  assert.equal(state.items.length, 0);
  assert.equal(state.unread, null);
  assert.equal(state.loaded, false);
  assert.equal(state.nextCursor, null);
  assert.equal(state.pending, null);
  assert.deepEqual(f.calls.filter((call) => call.kind === "mark").map(({ actor, id }) => [actor, id]), [[ORIGINAL, undefined]]);
  assert.ok(f.accounts.get(ORIGINAL)!.every((row) => row.readAt === null));
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
  assert.equal(f.calls.filter((call) => call.kind === "actor").length, 1, "the failed action never silently rebinds itself");
});

test("a stale individual read retains its original notification ID and recipient restriction", async () => {
  const f = await ready();
  const id = f.controller.getSnapshot().items[0]!.item.id;
  f.select(REPLACEMENT);
  await f.controller.markRead(id);
  assert.equal(f.controller.getSnapshot().error, "account-changed");
  assert.deepEqual(f.calls.filter((call) => call.kind === "mark").map(({ actor, id }) => [actor, id]), [[ORIGINAL, id]]);
  assert.ok(f.accounts.get(ORIGINAL)!.every((row) => row.readAt === null));
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
  assert.equal(f.controller.getSnapshot().items.length, 0);
});

test("repeating a mutation after an account conflict cannot implicitly confirm or load the new account", async () => {
  const f = await ready();
  f.select(REPLACEMENT);
  await f.controller.markRead();
  const failed = f.controller.getSnapshot();
  const calls = f.calls.length;
  await f.controller.markRead();
  await f.controller.markRead(f.accounts.get(REPLACEMENT)![0]!.id);
  assert.equal(f.calls.length, calls);
  assert.equal(f.controller.getSnapshot(), failed);
  assert.equal(failed.error, "account-changed");
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
});

test("an explicit read after conflict verifies the new account without replaying the old mutation", async () => {
  const f = await ready();
  f.select(REPLACEMENT);
  await f.controller.markRead();
  await f.controller.refresh();
  const state = f.controller.getSnapshot();
  assert.equal(state.actorId, REPLACEMENT);
  assert.equal(state.error, null);
  assert.equal(state.items.length, 2);
  assert.equal(state.unread, 2);
  assert.ok(state.items.every((row) => row.item.id.startsWith("20000000")));
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, 1);
  assert.equal(f.calls.filter((call) => call.kind === "actor").length, 2);
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
});

test("a badge conflict clears already-loaded history rather than preserving a stale private feed", async () => {
  const f = await ready(52);
  await f.controller.loadMore();
  f.select(REPLACEMENT);
  await f.controller.refreshSummary();
  const state = f.controller.getSnapshot();
  assert.equal(state.error, "account-changed");
  assert.equal(state.items.length, 0);
  assert.equal(state.unread, null);
  assert.equal(state.actorId, null);
  assert.equal(state.status, "error");
  assert.equal(f.calls.at(-1)!.actor, ORIGINAL);
});

test("a replacement account between identity and the first read cannot publish half of a mixed snapshot", async () => {
  const f = fixture();
  f.transport.actor = async () => { f.select(REPLACEMENT); return ORIGINAL; };
  f.transport.page = async () => pageOf(f.accounts.get(ORIGINAL)!);
  const published: number[] = [];
  const stop = f.controller.subscribe(() => published.push(f.controller.getSnapshot().items.length));
  const release = f.controller.watchFeed();
  await f.controller.connect(true);
  assert.equal(f.controller.getSnapshot().error, "account-changed");
  assert.equal(f.controller.getSnapshot().unread, null);
  assert.ok(published.every((count) => count === 0));
  assert.equal(f.calls.filter((call) => call.kind === "count")[0]!.actor, ORIGINAL);
  release(); stop();
});

test("a history conflict discards the previous cursor, so the next recipient starts at page one", async () => {
  const f = await ready(52);
  const cursor = f.controller.getSnapshot().nextCursor;
  assert.ok(cursor);
  f.select(REPLACEMENT);
  await f.controller.loadMore();
  assert.equal(f.controller.getSnapshot().items.length, 0);
  assert.equal(f.controller.getSnapshot().nextCursor, null);
  assert.equal(f.calls.at(-1)!.cursor, cursor);
  await f.controller.refresh();
  const replacementPages = f.calls.filter((call) => call.kind === "page" && call.actor === REPLACEMENT);
  assert.deepEqual(replacementPages.map((call) => call.cursor), [null]);
  assert.equal(f.controller.getSnapshot().items.length, 2);
});

test("an accepted original-account write followed by a replacement count clears display without touching the replacement", async () => {
  const f = await ready();
  const mark = f.transport.mark;
  f.transport.mark = async (id, signal, actor) => {
    const acknowledgement = await mark(id, signal, actor);
    f.select(REPLACEMENT);
    return acknowledgement;
  };
  await f.controller.markRead();
  assert.ok(f.accounts.get(ORIGINAL)!.every((row) => row.readAt !== null));
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
  assert.equal(f.controller.getSnapshot().items.length, 0);
  assert.equal(f.controller.getSnapshot().unread, null);
  assert.equal(f.controller.getSnapshot().error, "account-changed");
  assert.equal(f.calls.at(-1)!.actor, ORIGINAL);
});

test("failed reconciliation after an accepted mark stays actor-bound and never becomes another mark", async () => {
  const f = await ready();
  const count = f.transport.count;
  f.transport.count = async () => { throw new NotificationRequestError("unavailable"); };
  await f.controller.markRead(f.accounts.get(ORIGINAL)![0]!.id);
  assert.equal(f.controller.getSnapshot().actorId, ORIGINAL);
  assert.equal(f.controller.getSnapshot().items[0]!.read, true);
  assert.equal(f.controller.getSnapshot().unread, 3);
  f.transport.count = count;
  f.select(REPLACEMENT);
  await f.controller.refreshSummary();
  assert.equal(f.controller.getSnapshot().error, "account-changed");
  assert.equal(f.controller.getSnapshot().items.length, 0);
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, 1);
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
});

test("a late original-account identity cannot overwrite a newer verified replacement", async () => {
  const f = fixture();
  const identity = deferred<string>(), entered = deferred<void>();
  let attempts = 0;
  f.transport.actor = async () => { if (++attempts === 1) { entered.resolve(); return identity.promise; } return REPLACEMENT; };
  const old = f.controller.connect(true);
  await entered.promise;
  f.select(REPLACEMENT);
  await f.controller.connect(true);
  const current = f.controller.getSnapshot();
  identity.resolve(ORIGINAL);
  await old;
  assert.equal(f.controller.getSnapshot(), current);
  assert.equal(current.actorId, REPLACEMENT);
  assert.equal(current.unread, 2);
  assert.ok(f.calls.every((call) => call.actor === REPLACEMENT));
});

test("an old identity 401 cannot sign out a successfully reconnected replacement shell", async () => {
  const f = fixture();
  const identity = deferred<string>(), entered = deferred<void>();
  let attempts = 0;
  f.transport.actor = async () => { if (++attempts === 1) { entered.resolve(); return identity.promise; } return REPLACEMENT; };
  const old = f.controller.connect(true);
  await entered.promise;
  f.select(REPLACEMENT);
  await f.controller.connect(true);
  const current = f.controller.getSnapshot();
  identity.reject(new NotificationRequestError("unauthenticated"));
  await old;
  assert.equal(f.controller.getSnapshot(), current);
  assert.equal(current.session, "active");
  assert.equal(current.actorId, REPLACEMENT);
  assert.equal(current.error, null);
});

test("hiding while identity is pending aborts verification and fences a transport that ignores cancellation", async () => {
  const f = fixture();
  const identity = deferred<string>(), entered = deferred<void>();
  let verifying: AbortSignal | undefined;
  f.transport.actor = async (signal) => { verifying = signal; entered.resolve(); return identity.promise; };
  const old = f.controller.connect(true);
  await entered.promise;
  await f.controller.connect(false);
  assert.equal(verifying?.aborted, true);
  const hidden = f.controller.getSnapshot();
  identity.resolve(ORIGINAL);
  await old;
  assert.equal(f.controller.getSnapshot(), hidden);
  assert.equal(hidden.actorId, null);
  assert.equal(hidden.items.length, 0);
  assert.equal(f.calls.length, 0);
});

test("a delayed page cannot contaminate a replacement recipient even when it ignores the aborted signal", async () => {
  const f = await ready(52);
  const older = deferred<NotificationPage>(), entered = deferred<void>();
  const staleRows = f.accounts.get(ORIGINAL)!.slice(50);
  let paging: AbortSignal | undefined;
  const page = f.transport.page;
  f.transport.page = async (cursor, signal, actor) => {
    if (cursor) { paging = signal; entered.resolve(); return older.promise; }
    return page(cursor, signal, actor);
  };
  const old = f.controller.loadMore();
  await entered.promise;
  f.select(REPLACEMENT);
  await f.controller.connect(true);
  await f.controller.refresh();
  const replacement = f.controller.getSnapshot();
  older.resolve(pageOf(staleRows));
  await old;
  assert.equal(paging?.aborted, true);
  assert.equal(f.controller.getSnapshot(), replacement);
  assert.equal(replacement.actorId, REPLACEMENT);
  assert.ok(replacement.items.every((row) => row.item.id.startsWith("20000000")));
});

test("a late mark acknowledgement cannot confirm read state or count for a different recipient", async () => {
  const f = await ready();
  const acknowledged = deferred<NotificationItem | number>(), entered = deferred<void>();
  let submittedActor = "";
  f.transport.mark = async (_id, _signal, actor) => { submittedActor = actor; entered.resolve(); return acknowledged.promise; };
  const old = f.controller.markRead();
  await entered.promise;
  f.select(REPLACEMENT);
  await f.controller.connect(true);
  await f.controller.refresh();
  const replacement = f.controller.getSnapshot();
  acknowledged.resolve(3);
  await old;
  assert.equal(submittedActor, ORIGINAL);
  assert.equal(f.controller.getSnapshot(), replacement);
  assert.equal(replacement.actorId, REPLACEMENT);
  assert.equal(replacement.unread, 2);
  assert.ok(replacement.items.every((row) => !row.read));
});

test("overlapping auth changes fence identity lookups as well as notification resource requests", async () => {
  const f = await ready();
  const first = f.controller.beginSessionChange(), second = f.controller.beginSessionChange();
  const calls = f.calls.length;
  assert.equal(f.controller.getSnapshot().actorId, null);
  await f.controller.connect(true);
  first();
  await f.controller.connect(true);
  await f.controller.refresh();
  assert.equal(f.calls.length, calls);
  assert.equal(f.controller.getSnapshot().session, "signed-out");
  second(); second();
  f.select(REPLACEMENT);
  await f.controller.connect(true);
  assert.equal(f.controller.getSnapshot().actorId, REPLACEMENT);
  assert.equal(f.calls.filter((call) => call.kind === "actor").length, 2);
});

test("a temporary list failure does not silently rebind a pinned recipient during an explicit retry", async () => {
  const f = await ready(52);
  const page = f.transport.page;
  const before = f.controller.getSnapshot();
  f.transport.page = async () => { throw new NotificationRequestError("timeout"); };
  await f.controller.loadMore();
  assert.equal(f.controller.getSnapshot().actorId, ORIGINAL);
  assert.equal(f.controller.getSnapshot().items, before.items);
  assert.equal(f.controller.getSnapshot().nextCursor, before.nextCursor);
  f.transport.page = page;
  f.select(REPLACEMENT);
  await f.controller.loadMore();
  assert.equal(f.controller.getSnapshot().error, "account-changed");
  assert.equal(f.controller.getSnapshot().items.length, 0);
  assert.equal(f.calls.filter((call) => call.kind === "actor").length, 1);
});

test("two visible consumers during verification share a feed result without ever making an unbound call", async () => {
  const f = fixture();
  const left: unknown[] = [], right: unknown[] = [];
  const stopLeft = f.controller.subscribe(() => left.push(f.controller.getSnapshot()));
  const stopRight = f.controller.subscribe(() => right.push(f.controller.getSnapshot()));
  const connecting = f.controller.connect(true);
  const first = f.controller.watchFeed(), second = f.controller.watchFeed();
  await f.controller.refresh();
  await connecting;
  assert.deepEqual(left, right);
  assert.equal(f.controller.getSnapshot().actorId, ORIGINAL);
  assert.equal(f.calls.filter((call) => call.kind === "page").length, 1);
  assert.ok(f.calls.filter((call) => call.kind !== "actor").every((call) => call.actor === ORIGINAL));
  first(); second(); stopLeft(); stopRight();
});

test("mutation serialization retains the original actor while its authoritative count is pending", async () => {
  const f = await ready();
  const count = deferred<number>(), entered = deferred<void>();
  let reconciledActor = "";
  f.transport.count = async (_signal, actor) => { reconciledActor = actor; entered.resolve(); return count.promise; };
  const first = f.controller.markRead(f.accounts.get(ORIGINAL)![0]!.id);
  await entered.promise;
  f.select(REPLACEMENT);
  const second = f.controller.markRead();
  assert.equal(first, second);
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, 1);
  assert.equal(reconciledActor, ORIGINAL);
  count.reject(new NotificationRequestError("account-changed"));
  await first;
  assert.equal(f.controller.getSnapshot().actorId, null);
  assert.equal(f.controller.getSnapshot().error, "account-changed");
  assert.ok(f.accounts.get(REPLACEMENT)!.every((row) => row.readAt === null));
});

test("independent mounted shells cannot share a verified actor or a delayed identity operation", async () => {
  const first = fixture(), second = fixture();
  second.select(REPLACEMENT);
  await Promise.all([first.controller.connect(true), second.controller.connect(true)]);
  assert.equal(first.controller.getSnapshot().actorId, ORIGINAL);
  assert.equal(second.controller.getSnapshot().actorId, REPLACEMENT);
  await first.controller.connect(false);
  await tick();
  assert.equal(second.controller.getSnapshot().actorId, REPLACEMENT);
  assert.equal(second.controller.getSnapshot().unread, 2);
  assert.equal(first.controller.getServerSnapshot().actorId, null);
  assert.equal(second.controller.getServerSnapshot().actorId, null);
});

test("publishing a newly verified actor cannot start a private read after a subscriber begins logout", async () => {
  const f = fixture();
  let finish: (() => void) | undefined;
  const stop = f.controller.subscribe(() => {
    if (f.controller.getSnapshot().actorId === ORIGINAL) finish = f.controller.beginSessionChange();
  });
  await f.controller.connect(true);
  assert.equal(f.calls.filter((call) => call.kind === "actor").length, 1);
  assert.equal(f.calls.filter((call) => call.kind !== "actor").length, 0);
  assert.equal(f.controller.getSnapshot().actorId, null);
  assert.equal(f.controller.getSnapshot().session, "signed-out");
  stop(); finish!();
  f.select(REPLACEMENT);
  await f.controller.connect(true);
  assert.equal(f.controller.getSnapshot().actorId, REPLACEMENT);
  assert.equal(f.controller.getSnapshot().unread, 2);
});

test("account conflict removal and its explanation are one atomic snapshot for every subscriber", async () => {
  const f = await ready();
  const cleared: { error: string | null; count: number; unread: number | null }[] = [];
  const stop = f.controller.subscribe(() => {
    const state = f.controller.getSnapshot();
    if (state.actorId === null) cleared.push({ error: state.error, count: state.items.length, unread: state.unread });
  });
  f.select(REPLACEMENT);
  await f.controller.markRead();
  assert.deepEqual(cleared, [{ error: "account-changed", count: 0, unread: null }]);
  assert.equal(f.controller.getSnapshot().pending, null);
  stop();
});

test("an initial identity 401 signs out without an unbound badge, page or mutation retry", async () => {
  const f = fixture();
  let attempts = 0;
  f.transport.actor = async () => { attempts++; throw new NotificationRequestError("unauthenticated"); };
  await f.controller.connect(true);
  await f.controller.refresh();
  await f.controller.markRead();
  assert.equal(attempts, 1);
  assert.equal(f.controller.getSnapshot().session, "signed-out");
  assert.equal(f.controller.getSnapshot().actorId, null);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.equal(f.calls.length, 0);
  f.transport.actor = async () => ORIGINAL;
  await f.controller.connect(true);
  assert.equal(f.controller.getSnapshot().actorId, ORIGINAL);
  assert.equal(f.controller.getSnapshot().unread, 3);
});

test("a failed replacement identity cannot revive the previous verified recipient as a fallback", async () => {
  const f = await ready();
  f.select(REPLACEMENT);
  const before = f.calls.length;
  f.transport.actor = async () => { throw new NotificationRequestError("unavailable"); };
  await f.controller.connect(true);
  await f.controller.markRead();
  assert.equal(f.calls.length, before);
  assert.equal(f.controller.getSnapshot().actorId, null);
  assert.equal(f.controller.getSnapshot().items.length, 0);
  assert.equal(f.controller.getSnapshot().unread, null);
  assert.equal(f.controller.getSnapshot().error, "unavailable");
  f.transport.actor = async () => REPLACEMENT;
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().actorId, REPLACEMENT);
  assert.ok(f.calls.slice(before).every((call) => call.actor === REPLACEMENT));
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, 0);
});
