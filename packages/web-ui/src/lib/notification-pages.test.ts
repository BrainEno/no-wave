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
