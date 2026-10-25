import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteClient, runSqliteMigrations } from "./sqlite.mjs";
import { createSqliteStore } from "./sqlite-store.mjs";
import { dispatchOutboxBatch } from "./outbox-worker.mjs";

async function fixture() {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const adapter = createSqliteStore(db);
  const conversation = await adapter.createConversation({
    actorId: "alice",
    participantIds: ["bob"],
  });
  const message = await adapter.persistMessage({
    conversationId: conversation.id,
    senderId: "alice",
    body: "A message whose delivery is deferred to the outbox worker.",
    idempotencyKey: "worker-contract-message",
  });
  return { db, adapter, message };
}

test("composed SQLite adapter dispatches a message outbox event and marks it delivered", async () => {
  const { db, adapter, message } = await fixture();
  try {
    const delivered = [];
    const result = await dispatchOutboxBatch({
      store: adapter,
      deliver: async (event) => delivered.push(event),
      limit: 10,
      leaseSeconds: 30,
    });

    assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0 });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].event_key, `message:${message.id}`);
    assert.equal(delivered[0].event_type, "message.created");
    assert.deepEqual(delivered[0].payload, {
      messageId: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
    });
    assert.equal(await adapter.markOutboxDelivered({ eventId: delivered[0].id }), false);
    assert.deepEqual(await adapter.claimOutboxEvents({ limit: 10 }), []);
    assert.equal(db.prepare("SELECT count(*) AS count FROM outbox_events WHERE delivered_at IS NOT NULL").get().count, 1);
  } finally {
    db.close();
  }
});

test("composed SQLite adapter preserves failed deliveries and schedules a retry", async () => {
  const { db, adapter, message } = await fixture();
  try {
    const result = await dispatchOutboxBatch({
      store: adapter,
      deliver: async () => { throw new Error("temporary delivery failure"); },
      limit: 10,
      leaseSeconds: 30,
      retryDelaySeconds: 30,
    });

    assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1 });
    const row = db.prepare("SELECT event_key, attempts, available_at, delivered_at FROM outbox_events WHERE event_key = ?").get(`message:${message.id}`);
    assert.ok(row);
    assert.equal(row.attempts, 1);
    assert.equal(row.delivered_at, null);
    assert.ok(Date.parse(row.available_at) > Date.now());
    assert.deepEqual(await adapter.claimOutboxEvents({ limit: 10 }), []);
  } finally {
    db.close();
  }
});
