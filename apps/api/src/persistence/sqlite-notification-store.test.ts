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

/**
 * The batch write is what makes a deletion with many commenters affordable
 * (audit F-23).
 *
 * The count that matters is `BEGIN IMMEDIATE`, not rows inserted: on a
 * single-writer database every transaction is a chance for every other writer to
 * wait. Deleting a work tells up to 200 commenters, which used to be 200 of them.
 */
test("SQLite writes a page of inbox rows in one transaction, and one conflict still rolls back the batch", async () => {
  const { db, store } = await fixture();
  const transactions: string[] = [];
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    transactions.push(sql);
    return exec(sql);
  };
  try {
    const inputs = Array.from({ length: 120 }, (_, index) => ({
      userId: `reader-${index}`,
      eventKey: `article.deleted:article-1:reader-${index}`,
      payload: { type: "article.deleted", articleId: "article-1", purgesAt: "2026-12-01T00:00:00.000Z" },
    }));
    const receipts = await store.createNotifications(inputs);

    assert.equal(transactions.filter((sql) => /^BEGIN/i.test(sql)).length, 1, "one transaction for the whole page");
    assert.equal(transactions.filter((sql) => /^COMMIT/i.test(sql)).length, 1);
    assert.equal(receipts.length, inputs.length);
    assert.deepEqual(receipts.map((receipt) => receipt.userId), inputs.map((input) => input.userId), "receipts keep input order");
    assert.ok(receipts.every((receipt) => receipt.duplicate === false));
    assert.equal(db.prepare("SELECT count(*) AS count FROM notifications").get().count, inputs.length);

    // Replaying the same batch is all duplicates, and writes nothing new.
    const replay = await store.createNotifications(inputs);
    assert.ok(replay.every((receipt) => receipt.duplicate === true));
    assert.deepEqual(replay.map((receipt) => receipt.id), receipts.map((receipt) => receipt.id));

    // One conflicting key refuses the whole call: the new key in the same batch
    // must not survive the rollback.
    await assert.rejects(
      store.createNotifications([
        { userId: "reader-0", eventKey: "article.deleted:article-1:reader-0", payload: { type: "different" } },
        { userId: "late-reader", eventKey: "article.deleted:article-1:late-reader", payload: { type: "article.deleted" } },
      ]),
      IdempotencyConflictError,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM notifications WHERE user_id = ?").get("late-reader").count,
      0,
      "the batch is one transaction: nothing from it may land",
    );

    // An empty page opens no transaction at all.
    const before = transactions.length;
    assert.deepEqual(await store.createNotifications([]), []);
    assert.equal(transactions.length, before);
  } finally {
    db.close();
  }
});

test("SQLite inbox paging uses the (created_at, id) boundary and skips nothing in the boundary millisecond", async () => {
  const { db, store } = await fixture();
  try {
    const sameMs = "2026-06-01T00:00:00.123Z";
    // Newest first: one notice above the shared millisecond, three inside it,
    // one below. The three inside it are ordered by descending id.
    const rows = [];
    for (const [index, createdAt] of [
      "2026-06-01T00:00:00.124Z", sameMs, sameMs, sameMs, "2026-06-01T00:00:00.122Z",
    ].entries()) {
      const created = await store.createNotification({
        userId: "user-a", eventKey: `page-${index}`, payload: { index },
      });
      db.prepare("UPDATE notifications SET created_at = ? WHERE id = ?").run(createdAt, created.id);
      rows.push({ id: created.id, createdAt });
    }
    const expected = [...rows]
      .sort((left, right) => (left.createdAt === right.createdAt
        ? (left.id < right.id ? 1 : -1)
        : (left.createdAt < right.createdAt ? 1 : -1)))
      .map((row) => row.id);

    const seen = [];
    let last = null;
    for (;;) {
      const page = await store.listNotifications({
        actorId: "user-a", limit: 2,
        ...(last === null ? {} : { cursor: { at: last.createdAt, id: last.id } }),
      });
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      last = page[page.length - 1];
    }
    assert.deepEqual(seen, expected, "every notice is read once, in order");
    assert.equal(new Set(seen).size, expected.length);

    // A cursor that names the middle of the shared millisecond continues after it.
    const mid = expected[2];
    const midRow = rows.find((row) => row.id === mid);
    const rest = await store.listNotifications({ actorId: "user-a", limit: 10, cursor: { at: midRow.createdAt, id: midRow.id } });
    assert.deepEqual(rest.map((row) => row.id), expected.slice(3));
  } finally { db.close(); }
});
