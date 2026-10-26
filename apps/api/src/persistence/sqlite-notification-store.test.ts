import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteNotificationStore } from "./sqlite-notification-store.ts";
import { IdempotencyConflictError, InvalidMessageCursorError } from "../domain/errors.ts";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  return { db, store: createSqliteNotificationStore(db) };
}

test("SQLite notifications are idempotent and reject event-key payload conflicts", async () => {
  const { db, store } = await fixture();
  try {
    const payload = { type: "test.event", nested: { value: 1 } };
    const first = await store.createNotification({ userId: "user-a", eventKey: "event-1", payload });
    const duplicate = await store.createNotification({ userId: "user-a", eventKey: "event-1", payload });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.id, first.id);
    assert.deepEqual(duplicate.payload, payload);
    await assert.rejects(store.createNotification({
      userId: "user-a", eventKey: "event-1", payload: { type: "different" },
    }), IdempotencyConflictError);
    assert.equal(db.prepare("SELECT count(*) AS count FROM notifications").get().count, 1);
  } finally { db.close(); }
});

test("SQLite notifications list, count, and mark-read operations are user-scoped", async () => {
  const { db, store } = await fixture();
  try {
    const first = await store.createNotification({ userId: "user-a", eventKey: "event-1", payload: { type: "one" } });
    const second = await store.createNotification({ userId: "user-a", eventKey: "event-2", payload: { type: "two" } });
    await store.createNotification({ userId: "user-b", eventKey: "event-3", payload: { type: "private" } });
    assert.equal(await store.getUnreadNotificationCount({ actorId: "user-a" }), 2);
    assert.equal((await store.listNotifications({ actorId: "user-a" })).length, 2);
    assert.equal((await store.markNotificationRead({ notificationId: first.id, actorId: "user-b" })), null);
    const read = await store.markNotificationRead({ notificationId: first.id, actorId: "user-a" });
    assert.equal(read.id, first.id);
    assert.ok(read.readAt);
    assert.equal((await store.markNotificationRead({ notificationId: first.id, actorId: "user-a" })).readAt, read.readAt);
    assert.equal(await store.getUnreadNotificationCount({ actorId: "user-a" }), 1);
    assert.equal(await store.markAllNotificationsRead({ actorId: "user-a" }), 1);
    assert.equal(await store.getUnreadNotificationCount({ actorId: "user-a" }), 0);
    assert.equal((await store.markNotificationRead({ notificationId: second.id, actorId: "user-a" })).id, second.id);
  } finally { db.close(); }
});

test("SQLite notification operations validate inputs", async () => {
  const { db, store } = await fixture();
  try {
    await assert.rejects(store.listNotifications({ actorId: "user-a", limit: 101 }), TypeError);
    await assert.rejects(store.createNotification({ userId: " ", eventKey: "x", payload: {} }), TypeError);
    await assert.rejects(store.createNotification({ userId: "user-a", eventKey: "x" }), TypeError);
    await assert.rejects(store.markNotificationRead({ notificationId: "not-a-uuid", actorId: "user-a" }), InvalidMessageCursorError);
    assert.equal(await store.markNotificationRead({ notificationId: randomUUID(), actorId: "user-a" }), null);
  } finally { db.close(); }
});
