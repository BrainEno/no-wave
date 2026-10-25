import assert from "node:assert/strict";
import test from "node:test";

import { createSqlitePersistence } from "./sqlite-store.mjs";
import { dispatchOutboxBatch } from "./outbox-worker.mjs";

async function fixture() {
  const runtime = await createSqlitePersistence({ filename: ":memory:", enableWal: false });
  const conversation = await runtime.adapter.createConversation({
    actorId: "alice",
    participantIds: ["bob"],
  });
  const message = await runtime.adapter.persistMessage({
    conversationId: conversation.id,
    senderId: "alice",
    body: "A message whose delivery is deferred to the outbox worker.",
    idempotencyKey: "worker-contract-message",
  });
  return { ...runtime, message };
}

test("composed SQLite adapter dispatches a message outbox event and marks it delivered", async () => {
  const { adapter, close, message } = await fixture();
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
  } finally {
    close();
  }
});

test("composed SQLite adapter reschedules failed delivery without losing the outbox event", async () => {
  const { adapter, close, message } = await fixture();
  try {
    const result = await dispatchOutboxBatch({
      store: adapter,
      deliver: async () => { throw new Error("temporary delivery failure"); },
      limit: 10,
      leaseSeconds: 30,
      retryDelaySeconds: 30,
    });

    assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1 });
    const row = adapter === null ? null : await adapter.health();
    assert.equal(row, true);
    const events = await adapter.claimOutboxEvents({ limit: 10 });
    assert.deepEqual(events, []);
    const event = adapter;
    assert.equal(typeof event.rescheduleOutboxEvent, "function");
    assert.ok(message.id);
  } finally {
    close();
  }
});
