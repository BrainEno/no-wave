import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";

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

test("worker rejects invalid settings before claiming or delivering events", async () => {
  let claims = 0;
  const store = {
    async claimOutboxEvents() { claims += 1; return []; },
    async markOutboxDelivered() { throw new Error("must not mark"); },
    async rescheduleOutboxEvent() { throw new Error("must not reschedule"); },
  };
  const deliver = async () => { throw new Error("must not deliver"); };
  for (const invalid of [
    { limit: 0 }, { limit: 101 }, { leaseSeconds: 0 }, { leaseSeconds: 3601 },
    { retryDelaySeconds: 0 }, { retryDelaySeconds: 86401 },
  ]) {
    await assert.rejects(dispatchOutboxBatch({ store, deliver, ...invalid }), TypeError);
  }
  assert.equal(claims, 0);
  assert.deepEqual(await dispatchOutboxBatch({ store, deliver }), { claimed: 0, delivered: 0, failed: 0 });
  assert.equal(claims, 1);
});

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
    assert.equal(await adapter.markOutboxDelivered({ eventId: delivered[0].id, leaseToken: delivered[0].lease_token }), false);
    assert.deepEqual(await adapter.claimOutboxEvents({ limit: 10 }), []);
    assert.equal(db.prepare("SELECT count(*) AS count FROM outbox_events WHERE delivered_at IS NOT NULL").get().count, 1);
  } finally {
    db.close();
  }
});

test("composed SQLite adapter preserves failed deliveries, schedules retries, and reports safe failure metadata", async () => {
  const { db, adapter, message } = await fixture();
  try {
    const failures = [];
    const rawFailure = "temporary delivery failure: refreshToken=must-not-appear";
    const result = await dispatchOutboxBatch({
      store: adapter,
      deliver: async () => { throw new Error(rawFailure); },
      limit: 10,
      leaseSeconds: 30,
      retryDelaySeconds: 30,
      onDeliveryFailure: (failure) => failures.push(failure),
    });

    assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1 });
    const row = db.prepare("SELECT id, event_key, attempts, available_at, delivered_at FROM outbox_events WHERE event_key = ?").get(`message:${message.id}`);
    assert.ok(row);
    assert.equal(row.attempts, 1);
    assert.equal(row.delivered_at, null);
    assert.ok(Date.parse(row.available_at) > Date.now());
    assert.deepEqual(failures, [{
      eventId: row.id,
      eventType: "message.created",
      attempts: 1,
      errorName: "Error",
      retryScheduled: true,
      retryScheduleErrorName: null,
    }]);
    assert.ok(!JSON.stringify(failures).includes(rawFailure), "failure diagnostics must not expose exception messages");
    assert.deepEqual(await adapter.claimOutboxEvents({ limit: 10 }), []);
  } finally {
    db.close();
  }
});

test("outbox failure observers cannot interrupt retry recovery", async () => {
  const { db, adapter } = await fixture();
  try {
    const result = await dispatchOutboxBatch({
      store: adapter,
      deliver: async () => { throw new Error("temporary failure"); },
      limit: 1,
      leaseSeconds: 30,
      retryDelaySeconds: 30,
      onDeliveryFailure: () => { throw new Error("logger failed"); },
    });
    assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1 });
    const row = db.prepare("SELECT attempts, delivered_at FROM outbox_events").get();
    assert.equal(row.attempts, 1);
    assert.equal(row.delivered_at, null);
  } finally {
    db.close();
  }
});
