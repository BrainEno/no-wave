import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, encodeCursor } from "../../../../apps/api/src/domain/cursor.ts";
import { appendNotificationPage, fetchNotificationPage, notificationCursor, NOTIFICATION_PAGE_SIZE, parseNotificationPage } from "./notification-pages.ts";
import type { NotificationItem } from "./chrome.ts";

function item(index: number): NotificationItem {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    eventKey: `event-${index}`,
    payload: JSON.stringify({ type: "user.followed", followerId: `follower-${index}` }),
    createdAt: "2026-01-01T12:00:00.000Z",
    readAt: null,
  };
}

function page(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => item(start + index));
}

test("browser cursor round trips through the API codec including timestamp ties", () => {
  for (const index of [0, 1, 42, 999]) {
    const row = item(index);
    const cursor = notificationCursor(row);
    assert.equal(cursor, encodeCursor(row.createdAt, row.id));
    assert.deepEqual(decodeCursor(cursor), { at: row.createdAt, id: row.id });
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  }
});

test("cursor builder refuses malformed keys rather than making an invalid API request", () => {
  for (const createdAt of ["", "2026-01-01", "2026-01-01T12:00:00Z", "2026-01-01T12:00:00.000+00:00"]) {
    assert.throws(() => notificationCursor({ ...item(1), createdAt }), /游标/);
  }
  for (const id of ["", "not-a-uuid", "00000000-0000-0000-0000-000000000001"]) {
    assert.throws(() => notificationCursor({ ...item(1), id }), /游标/);
  }
});

test("full pages expose a continuation and short and empty pages end the walk", () => {
  assert.equal(NOTIFICATION_PAGE_SIZE, 50);
  const first = parseNotificationPage({ data: page(0, 50) });
  assert.equal(first.items.length, 50);
  assert.equal(first.nextCursor, notificationCursor(item(49)));
  const next = parseNotificationPage({ data: page(50, 49) });
  assert.equal(next.items.length, 49);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(parseNotificationPage({ data: [] }), { items: [], nextCursor: null });
});

test("malformed response shapes, entries and oversize pages fail visibly", () => {
  for (const payload of [null, [], {}, { data: null }, { data: [null] }, { data: [{ ...item(1), readAt: 7 }] }, { data: page(0, 51) }]) {
    assert.throws(() => parseNotificationPage(payload), /通知/);
  }
  const invalidLast = page(0, 50);
  invalidLast[49] = { ...invalidLast[49]!, id: "bad" };
  assert.throws(() => parseNotificationPage({ data: invalidLast }), /游标/);
});

test("appending preserves order and skips duplicates without mutating either input", () => {
  const existing = page(0, 3);
  const added = [item(2), item(3), item(3), item(4)];
  const result = appendNotificationPage(existing, { items: added, nextCursor: null });
  assert.deepEqual(result.map((row) => row.id), page(0, 5).map((row) => row.id));
  assert.equal(existing.length, 3);
  assert.equal(added.length, 4);
  assert.notEqual(result, existing);
});

test("page requests forward only the explicit cursor and preserve session failure", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, options) => {
      calls.push({ url: String(input), options });
      if (calls.length === 3) return new Response(null, { status: 401 });
      return Response.json({ data: calls.length === 1 ? page(0, 50) : page(50, 2) });
    };
    const first = await fetchNotificationPage();
    assert.ok(first?.nextCursor);
    const second = await fetchNotificationPage(first.nextCursor);
    assert.equal(second?.items.length, 2);
    assert.equal(second?.nextCursor, null);
    assert.equal(await fetchNotificationPage(), null);
    const initial = new URL(calls[0]!.url, "https://example.test");
    const continued = new URL(calls[1]!.url, "https://example.test");
    assert.equal(initial.pathname, "/api/authoring/notifications");
    assert.equal(initial.searchParams.get("limit"), "50");
    assert.equal(initial.searchParams.get("cursor"), null);
    assert.equal(continued.searchParams.get("cursor"), first.nextCursor);
    assert.equal(calls[0]!.options?.credentials, "same-origin");
    assert.equal(calls[0]!.options?.cache, "no-store");
  } finally { globalThis.fetch = original; }
});

test("failed or malformed responses do not look like an empty inbox", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(fetchNotificationPage(), /无法载入/);
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    await assert.rejects(fetchNotificationPage(), /格式/);
  } finally { globalThis.fetch = original; }
});

test("real SQLite keyset walk reaches every tied notification without exposing another user", async () => {
  const { createSqliteClient, runSqliteMigrations } = await import("../../../../apps/api/src/persistence/sqlite.ts");
  const { createSqliteNotificationStore } = await import("../../../../apps/api/src/persistence/sqlite-notification-store.ts");
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteNotificationStore(db);
  try {
    const ids: string[] = [];
    for (let index = 0; index < 105; index++) {
      const created = await store.createNotification({ userId: "reader-a", eventKey: `notice-${index}`, payload: { type: "user.followed" } });
      db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run("2026-01-01T12:00:00.000Z", created.id);
      ids.push(created.id);
    }
    const other = await store.createNotification({ userId: "reader-b", eventKey: "private", payload: { type: "message.created" } });
    let cursor: string | null = null;
    let collected: NotificationItem[] = [];
    let pages = 0;
    do {
      const boundary = cursor === null ? null : decodeCursor(cursor);
      if (cursor !== null) assert.ok(boundary);
      const raw = await store.listNotifications({ actorId: "reader-a", limit: 50, cursor: boundary });
      // The HTTP serializer delivers payload as a JSON string.
      const parsed = parseNotificationPage({ data: raw.map((row) => ({ ...row, payload: JSON.stringify(row.payload) })) });
      collected = appendNotificationPage(collected, parsed);
      cursor = parsed.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(collected.length, 105);
    assert.equal(new Set(collected.map((row) => row.id)).size, 105);
    assert.deepEqual(collected.map((row) => row.id), ids.sort().reverse());
    assert.ok(!collected.some((row) => row.id === other.id));
    assert.equal(await store.getUnreadNotificationCount({ actorId: "reader-a" }), 105);
    await store.markNotificationRead({ actorId: "reader-a", notificationId: collected[100]!.id });
    assert.equal(await store.getUnreadNotificationCount({ actorId: "reader-a" }), 104);
    assert.equal(await store.markAllNotificationsRead({ actorId: "reader-a" }), 104);
    assert.equal(await store.getUnreadNotificationCount({ actorId: "reader-a" }), 0);
    assert.equal(await store.getUnreadNotificationCount({ actorId: "reader-b" }), 1);
  } finally { db.close(); }
});

test("an exactly full last page asks once more and terminates on an empty response", async () => {
  const original = globalThis.fetch;
  const all = page(0, 100);
  let requests = 0;
  try {
    globalThis.fetch = async () => {
      const start = requests++ * 50;
      return Response.json({ data: all.slice(start, start + 50) });
    };
    let cursor: string | null = null;
    let result: NotificationItem[] = [];
    do {
      const next = await fetchNotificationPage(cursor);
      assert.ok(next);
      result = appendNotificationPage(result, next);
      cursor = next.nextCursor;
    } while (cursor);
    assert.equal(requests, 3);
    assert.deepEqual(result, all);
  } finally { globalThis.fetch = original; }
});

test("continuing after a new first-page arrival does not repeat or lose older rows", () => {
  const original = page(0, 100);
  const first = parseNotificationPage({ data: original.slice(0, 50) });
  const second = parseNotificationPage({ data: original.slice(50) });
  // A newly arrived row belongs ahead of the existing cursor. It should be
  // obtained on the next refresh, not inserted into this historical walk.
  const arrival = item(999);
  const merged = appendNotificationPage(first.items, second);
  assert.equal(merged.length, 100);
  assert.ok(!merged.some((row) => row.id === arrival.id));
  assert.equal(first.nextCursor, notificationCursor(original[49]!));
  assert.equal(second.nextCursor, notificationCursor(original[99]!));
});
