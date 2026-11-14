import assert from "node:assert/strict";
import test from "node:test";
import { createNotificationController, notificationEntries } from "./notification-controller.ts";
import { NotificationRequestError, type NotificationTransport } from "./notification-transport.ts";
import { notificationCursor, type NotificationPage } from "./notification-pages.ts";
import type { NotificationItem } from "./chrome.ts";

function rows(count: number, highest = 1000): NotificationItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `20000000-0000-4000-8000-${(highest - index).toString(16).padStart(12, "0")}`,
    eventKey: `notification-${highest - index}`, payload: '{"type":"future.notice"}', createdAt: "2026-11-01T00:00:00.000Z", readAt: null }));
}
function page(items: NotificationItem[]): NotificationPage {
  return { items, nextCursor: items.length === 50 ? notificationCursor(items.at(-1)!) : null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(count = 3) {
  const items = rows(count);
  const calls: { kind: "count" | "page" | "mark"; signal: AbortSignal; cursor?: string | null; id?: string }[] = [];
  const transport: NotificationTransport = {
    async count(signal) { calls.push({ kind: "count", signal }); return items.filter((item) => item.readAt === null).length; },
    async page(cursor, signal) {
      calls.push({ kind: "page", signal, cursor });
      const start = cursor ? items.findIndex((item) => notificationCursor(item) === cursor) + 1 : 0;
      return page(items.slice(start, start + 50).map((item) => ({ ...item })));
    },
    async mark(id, signal) {
      calls.push({ kind: "mark", signal, id });
      const unread = items.filter((item) => item.readAt === null && (id === undefined || item.id === id));
      for (const item of unread) item.readAt = "2026-11-02T00:00:00.000Z";
      return id === undefined ? unread.length : { ...items.find((item) => item.id === id)! };
    },
  };
  return { controller: createNotificationController(transport), transport, items, calls };
}
async function ready(count = 3) {
  const f = fixture(count);
  await f.controller.connect(true);
  await f.controller.refresh();
  return f;
}

test("construction and server snapshots never perform private reads or assume a signed-in account", async () => {
  const f = fixture();
  const initial = f.controller.getSnapshot();
  assert.equal(initial.session, "unknown");
  assert.equal(initial.unread, null);
  assert.equal(f.controller.getServerSnapshot(), initial);
  assert.equal(f.controller.getSnapshot(), initial, "a snapshot is referentially stable until a transition");
  await f.controller.refresh();
  await f.controller.markRead();
  await f.controller.loadMore();
  assert.deepEqual(f.calls, []);
  await f.controller.connect(false);
  assert.equal(f.controller.getSnapshot().session, "signed-out");
  assert.equal(f.controller.getSnapshot().items.length, 0);
});

test("a session hint loads only the badge until a feed is actually visible", async () => {
  const f = fixture();
  await f.controller.connect(true);
  assert.deepEqual(f.calls.map((call) => call.kind), ["count"]);
  assert.equal(f.controller.getSnapshot().unread, 3);
  assert.equal(f.controller.getSnapshot().loaded, false);
  const stop = f.controller.watchFeed();
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().items.length, 3);
  assert.equal(f.controller.getSnapshot().status, "ready");
  stop();
});

test("two mounted surfaces share one first-page request and identical immutable snapshots", async () => {
  const f = fixture();
  const left: unknown[] = [], right: unknown[] = [];
  const stopLeft = f.controller.subscribe(() => left.push(f.controller.getSnapshot()));
  const stopRight = f.controller.subscribe(() => right.push(f.controller.getSnapshot()));
  const opening = f.controller.connect(true);
  const releaseLeft = f.controller.watchFeed(), releaseRight = f.controller.watchFeed();
  await f.controller.refresh();
  await opening;
  assert.equal(f.calls.filter((call) => call.kind === "page").length, 1);
  assert.equal(f.calls.filter((call) => call.kind === "count").length, 1);
  assert.deepEqual(left, right);
  const snapshot = f.controller.getSnapshot();
  for (const value of [snapshot, snapshot.items, snapshot.items[0], snapshot.items[0]!.item]) assert.ok(Object.isFrozen(value));
  f.items[0]!.payload = "changed-on-server";
  assert.notEqual(snapshot.items[0]!.item.payload, f.items[0]!.payload);
  assert.equal(notificationEntries(snapshot)[0]!.notice.type, "unknown");
  releaseLeft(); releaseLeft(); releaseRight();
  stopLeft(); stopRight();
});

test("list and count publish as one read result; a failed half does not publish partial history", async () => {
  const f = fixture();
  await f.controller.connect(true);
  const list = deferred<NotificationPage>();
  f.transport.page = async () => list.promise;
  f.transport.count = async () => { throw new NotificationRequestError("unavailable"); };
  const loading = f.controller.refresh();
  await loading;
  assert.equal(f.controller.getSnapshot().items.length, 0);
  assert.equal(f.controller.getSnapshot().loaded, false);
  assert.equal(f.controller.getSnapshot().error, "unavailable");
  assert.equal(f.controller.getSnapshot().unread, 3, "the last confirmed badge is not reset to a fictional zero");
  list.resolve(page(f.items));
  await Promise.resolve();
  assert.equal(f.controller.getSnapshot().items.length, 0);
});

test("a failed refresh retains known rows, cursor and total, and an explicit retry reconciles them", async () => {
  const f = await ready(52);
  const before = f.controller.getSnapshot();
  const list = f.transport.page;
  f.transport.page = async () => { throw new Error("synthetic-private-diagnostic"); };
  await f.controller.refresh();
  const failed = f.controller.getSnapshot();
  assert.equal(failed.items, before.items);
  assert.equal(failed.nextCursor, before.nextCursor);
  assert.equal(failed.unread, 52);
  assert.equal(failed.error, "unavailable");
  assert.equal(failed.status, "ready");
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-diagnostic/);
  f.transport.page = list;
  f.items.unshift(...rows(1, 2000));
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().items[0]!.item.id, f.items[0]!.id);
  assert.equal(f.controller.getSnapshot().unread, 53);
  assert.equal(f.controller.getSnapshot().error, null);
});

test("loading history keeps prior rows and read confirmations while appending new unique identities", async () => {
  const f = await ready(52);
  const id = f.items[0]!.id;
  await f.controller.markRead(id);
  const before = f.controller.getSnapshot();
  const last = f.items.slice(50);
  f.transport.page = async () => page([{ ...f.items[0]!, readAt: null }, ...last]);
  await f.controller.loadMore();
  const after = f.controller.getSnapshot();
  assert.equal(after.items.length, 52);
  assert.deepEqual(after.items.slice(0, 50), before.items);
  assert.equal(after.items[0]!.read, true);
  assert.equal(after.nextCursor, null);
  const requests = f.calls.length;
  await f.controller.loadMore();
  assert.equal(f.calls.length, requests, "a finished walk does not keep probing");
});

test("page failures keep the same cursor for retry instead of silently dropping older notices", async () => {
  const f = await ready(52);
  const read = f.transport.page;
  const cursor = f.controller.getSnapshot().nextCursor;
  f.transport.page = async () => { throw new NotificationRequestError("timeout"); };
  await f.controller.loadMore();
  assert.equal(f.controller.getSnapshot().items.length, 50);
  assert.equal(f.controller.getSnapshot().nextCursor, cursor);
  assert.equal(f.controller.getSnapshot().error, "timeout");
  f.transport.page = read;
  await f.controller.loadMore();
  assert.equal(f.controller.getSnapshot().items.length, 52);
  assert.equal(f.controller.getSnapshot().error, null);
});

test("non-advancing, overlapping-only and cyclic continuations fail without consuming the cursor", async () => {
  for (const mode of ["same-cursor", "no-new-rows", "cycle"] as const) {
    const f = await ready(150);
    const firstCursor = f.controller.getSnapshot().nextCursor;
    if (mode === "cycle") await f.controller.loadMore();
    const before = f.controller.getSnapshot();
    const supplied = mode === "no-new-rows" ? f.items.slice(0, 2) : rows(2, 100);
    f.transport.page = async () => ({ items: supplied, nextCursor: mode === "no-new-rows" ? null : mode === "cycle" ? firstCursor : before.nextCursor });
    await f.controller.loadMore();
    assert.equal(f.controller.getSnapshot().error, "stalled-page", mode);
    assert.equal(f.controller.getSnapshot().items, before.items, mode);
    assert.equal(f.controller.getSnapshot().nextCursor, before.nextCursor, mode);
  }
});

test("single-read state comes from a matching server acknowledgement, then both subscribers see the new total", async () => {
  const f = await ready();
  const snapshots: unknown[] = [];
  const stop = f.controller.subscribe(() => snapshots.push(f.controller.getSnapshot()));
  await f.controller.markRead(f.items[0]!.id);
  const state = f.controller.getSnapshot();
  assert.equal(state.items[0]!.read, true);
  assert.equal(state.items[0]!.item.readAt, "2026-11-02T00:00:00.000Z");
  assert.equal(state.items[1]!.read, false);
  assert.equal(state.unread, 2);
  assert.equal(state.pending, null);
  assert.ok(snapshots.length >= 2);
  const writes = f.calls.filter((call) => call.kind === "mark").length;
  await f.controller.markRead(f.items[0]!.id);
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, writes, "a confirmed-read row does not submit a second write");
  stop();
});

test("failed mutations never optimistically erase unread rows and never retry themselves", async () => {
  const f = await ready();
  let writes = 0;
  f.transport.mark = async () => { writes++; throw new Error("synthetic-server-write-failure"); };
  await f.controller.markRead();
  assert.equal(writes, 1);
  assert.equal(f.controller.getSnapshot().items.filter((item) => !item.read).length, 3);
  assert.equal(f.controller.getSnapshot().unread, 3);
  assert.equal(f.controller.getSnapshot().error, "unavailable");
  await f.controller.refresh();
  assert.equal(writes, 1, "refresh is a read, not a replay after an ambiguous write");
});

test("mark-all confirms known rows without fabricating timestamps or treating changed rows as an unread total", async () => {
  const f = await ready(52);
  await f.controller.loadMore();
  f.transport.mark = async () => 0;
  f.transport.count = async () => 1;
  await f.controller.markRead();
  const state = f.controller.getSnapshot();
  assert.equal(state.items.length, 52, "loaded history is not discarded by marking read");
  assert.ok(state.items.every((row) => row.read));
  assert.ok(state.items.every((row) => row.item.readAt === null), "the client does not invent a persisted readAt");
  assert.equal(state.unread, 1, "a new server-side arrival is not overwritten by a local zero");
});

test("a failed count refresh after an accepted write preserves confirmed reads and the last known total", async () => {
  const f = await ready();
  const count = f.transport.count;
  f.transport.count = async () => { throw new NotificationRequestError("unavailable"); };
  await f.controller.markRead(f.items[0]!.id);
  assert.equal(f.controller.getSnapshot().items[0]!.read, true);
  assert.equal(f.controller.getSnapshot().unread, 3);
  assert.equal(f.controller.getSnapshot().error, "unavailable");
  f.transport.count = count;
  await f.controller.refreshSummary();
  assert.equal(f.controller.getSnapshot().unread, 2);
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, 1);
});

test("a mutation stays locked through its authoritative count refresh; concurrent clicks do not send another write", async () => {
  const f = await ready();
  const counted = deferred<number>();
  f.transport.count = async () => counted.promise;
  const marking = f.controller.markRead(f.items[0]!.id);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.controller.getSnapshot().pending, "mark");
  const repeated = f.controller.markRead(f.items[1]!.id);
  assert.equal(marking, repeated);
  assert.equal(f.calls.filter((call) => call.kind === "mark").length, 1);
  counted.resolve(2);
  await marking;
  assert.equal(f.controller.getSnapshot().pending, null);
});

test("a late badge response cannot overwrite the count from a newer first-page read", async () => {
  const f = fixture();
  const stale = deferred<number>(), started = deferred<void>();
  let calls = 0;
  f.transport.count = async () => { if (++calls === 1) { started.resolve(); return stale.promise; } return 3; };
  const opening = f.controller.connect(true);
  await started.promise;
  const release = f.controller.watchFeed();
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().unread, 3);
  stale.resolve(99);
  await opening;
  assert.equal(f.controller.getSnapshot().unread, 3);
  assert.equal(f.controller.getSnapshot().items.length, 3);
  release();
});

test("a late older page cannot resurrect unread state after a successful mark-all", async () => {
  const f = await ready(52);
  const read = f.transport.page;
  const older = deferred<NotificationPage>(), started = deferred<void>();
  const oldRows = f.items.slice(50).map((item) => ({ ...item }));
  let pageSignal: AbortSignal | undefined;
  f.transport.page = async (_cursor, signal) => { pageSignal = signal; started.resolve(); return older.promise; };
  const paging = f.controller.loadMore();
  await started.promise;
  await f.controller.markRead();
  assert.equal(pageSignal?.aborted, true);
  assert.equal(f.controller.getSnapshot().unread, 0);
  older.resolve(page(oldRows));
  await paging;
  assert.equal(f.controller.getSnapshot().items.length, 50);
  assert.ok(f.controller.getSnapshot().items.every((row) => row.read));
  f.transport.page = read;
  await f.controller.loadMore();
  assert.equal(f.controller.getSnapshot().items.length, 52);
  assert.ok(f.controller.getSnapshot().items.every((row) => row.read));
});

test("an explicit first-page refresh supersedes an older-page read rather than splicing stale history", async () => {
  const f = await ready(52);
  const original = f.transport.page;
  const older = deferred<NotificationPage>(), started = deferred<void>();
  f.transport.page = async (cursor, signal) => { if (cursor) { started.resolve(); return older.promise; } return original(cursor, signal); };
  const paging = f.controller.loadMore();
  await started.promise;
  f.items.unshift(...rows(1, 2000));
  await f.controller.refresh();
  const refreshed = f.controller.getSnapshot();
  older.resolve(page(rows(2, 100)));
  await paging;
  assert.equal(f.controller.getSnapshot(), refreshed);
  assert.equal(refreshed.items.length, 50);
  assert.equal(refreshed.items[0]!.item.id, f.items[0]!.id);
  assert.equal(refreshed.unread, 53);
});

test("session loss clears all private data immediately and ignores a late first-page answer", async () => {
  const f = await ready();
  const older = deferred<NotificationPage>(), started = deferred<void>();
  let signal: AbortSignal | undefined;
  f.transport.page = async (_cursor, current) => { signal = current; started.resolve(); return older.promise; };
  const loading = f.controller.refresh();
  await started.promise;
  await f.controller.connect(false);
  const cleared = f.controller.getSnapshot();
  assert.equal(signal?.aborted, true);
  assert.equal(cleared.items.length, 0);
  assert.equal(cleared.unread, null);
  assert.equal(cleared.nextCursor, null);
  assert.equal(cleared.pending, null);
  older.resolve(page(f.items));
  await loading;
  assert.equal(f.controller.getSnapshot(), cleared);
});

test("replacement sessions cannot inherit a late read or write even when their readable hint is identical", async () => {
  const f = await ready();
  const write = deferred<NotificationItem | number>(), started = deferred<void>();
  f.transport.mark = async () => { started.resolve(); return write.promise; };
  const marking = f.controller.markRead();
  await started.promise;
  f.items.splice(0, f.items.length, ...rows(1, 5000));
  await f.controller.connect(true);
  await f.controller.refresh();
  const replacement = f.controller.getSnapshot();
  assert.equal(replacement.items.length, 1);
  assert.equal(replacement.unread, 1);
  write.resolve(3);
  await marking;
  assert.equal(f.controller.getSnapshot(), replacement);
  assert.equal(replacement.items[0]!.read, false);
});

test("401 from count, page or mutation signs out both consumers and cancels its sibling request", async () => {
  for (const endpoint of ["count", "page", "mark"] as const) {
    const f = await ready();
    f.transport[endpoint] = async () => { throw new NotificationRequestError("unauthenticated"); };
    if (endpoint === "mark") await f.controller.markRead();
    else await f.controller.refresh();
    const state = f.controller.getSnapshot();
    assert.equal(state.session, "signed-out", endpoint);
    assert.equal(state.items.length, 0, endpoint);
    assert.equal(state.unread, null, endpoint);
    assert.equal(state.error, null, endpoint);
    assert.equal(state.pending, null, endpoint);
  }
});

test("separate shell instances and SSR snapshots never share one account's private notifications", async () => {
  const first = await ready();
  const second = fixture();
  assert.equal(second.controller.getSnapshot().items.length, 0);
  assert.equal(second.controller.getSnapshot().unread, null);
  assert.equal(first.controller.getServerSnapshot().items.length, 0);
  assert.equal(first.controller.getServerSnapshot().unread, null);
  assert.equal(first.controller.getServerSnapshot().session, "unknown");
  await first.controller.connect(false);
  assert.equal(second.calls.length, 0);
});

test("an in-flight login or logout clears private state and fences automatic reconnects until it settles", async () => {
  const f = await ready();
  const finish = f.controller.beginSessionChange();
  assert.equal(f.controller.getSnapshot().session, "signed-out");
  assert.equal(f.controller.getSnapshot().items.length, 0);
  const calls = f.calls.length;
  await f.controller.connect(true);
  await f.controller.refresh();
  assert.equal(f.calls.length, calls, "focus or online while logout is pending must not read the old cookie");
  assert.equal(f.controller.getSnapshot().unread, null);
  finish();
  finish();
  assert.equal(f.calls.length, calls, "settling an auth request does not itself replay a private read");
  await f.controller.connect(true);
  assert.equal(f.controller.getSnapshot().unread, 3);
});

test("overlapping auth changes cannot release each other's fence or publish a late old acknowledgement", async () => {
  const f = await ready();
  const accepted = deferred<NotificationItem | number>(), started = deferred<void>();
  f.transport.mark = async () => { started.resolve(); return accepted.promise; };
  const marking = f.controller.markRead();
  await started.promise;
  const first = f.controller.beginSessionChange(), second = f.controller.beginSessionChange();
  first();
  await f.controller.connect(true);
  assert.equal(f.controller.getSnapshot().session, "signed-out");
  second();
  f.items.splice(0, f.items.length, ...rows(1, 9000));
  await f.controller.connect(true);
  await f.controller.refresh();
  const replacement = f.controller.getSnapshot();
  accepted.resolve(3);
  await marking;
  assert.equal(f.controller.getSnapshot(), replacement);
  assert.equal(replacement.items[0]!.read, false);
  assert.equal(replacement.unread, 1);
});
