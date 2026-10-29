import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { runOutboxDrain } from "./outbox-drain.ts";

/**
 * Bounded-drain behavior.
 *
 * The drain is what runs on a host with no free worker process, so the tests pin
 * the properties an operator depends on: it keeps going while there is due work,
 * it stops on a deadline or a batch cap instead of overrunning the invocation, it
 * reports a batch-level failure rather than swallowing it, and it reuses the same
 * claim/lease/reschedule semantics as the long-lived worker.
 */

type Store = Parameters<typeof dispatchOutboxBatch>[0]["store"];

/** A store that hands out `available` events, one per claim, forever. */
function endlessStore(available: number) {
  let claimed = 0;
  return {
    async claimOutboxEvents({ limit }: { limit: number }) {
      if (claimed >= available) return [];
      const batch = Math.min(limit, available - claimed);
      claimed += batch;
      return Array.from({ length: batch }, (_, index) => ({
        id: `event-${claimed - batch + index + 1}`,
        event_type: "message.created",
        event_key: `message:${claimed - batch + index + 1}`,
        payload: {},
        attempts: 1,
        lease_token: `lease-${claimed}`,
      }));
    },
    async markOutboxDelivered() {
      return true;
    },
    async rescheduleOutboxEvent() {
      return true;
    },
  } as unknown as Store;
}

test("the drain keeps claiming until the outbox is empty", async () => {
  const store = endlessStore(5);
  const result = await runOutboxDrain({ store, deliver: async () => {}, batchLimit: 2 });

  assert.equal(result.claimed, 5);
  assert.equal(result.delivered, 5);
  assert.equal(result.failed, 0);
  // 2 + 2 + 1, and the final empty batch is what proves the outbox is drained.
  assert.equal(result.batches, 4);
  assert.equal(result.stopReason, "empty");
  assert.equal(result.errorName, null);
});

test("the drain stops at its batch cap and says so", async () => {
  const store = endlessStore(100);
  const result = await runOutboxDrain({ store, deliver: async () => {}, batchLimit: 5, maxBatches: 3 });

  assert.equal(result.batches, 3);
  assert.equal(result.claimed, 15);
  assert.equal(result.stopReason, "batch-limit");
});

test("the drain stops at its wall-clock deadline", async () => {
  const store = endlessStore(1_000);
  const result = await runOutboxDrain({
    store,
    deliver: async () => {},
    batchLimit: 1,
    maxBatches: 100,
    deadlineMs: 1_000,
    // A clock that advances faster than the loop, so the deadline is hit without
    // a real sleep.
    now: (() => {
      let tick = 0;
      return () => (tick += 120);
    })(),
  });

  assert.equal(result.stopReason, "deadline");
  assert.ok(result.batches < 100, "the deadline must cut the loop short");
  assert.ok(result.durationMs >= 1_000);
});

test("a batch-level failure stops the drain and is reported by error class", async () => {
  let calls = 0;
  const store = {
    async claimOutboxEvents() {
      calls += 1;
      if (calls > 1) throw new Error("connection terminated");
      return [{ id: "event-1", event_type: "message.created", event_key: "message:1", payload: {}, attempts: 1, lease_token: "lease-1" }];
    },
    async markOutboxDelivered() {
      return true;
    },
    async rescheduleOutboxEvent() {
      return true;
    },
  } as unknown as Store;

  const result = await runOutboxDrain({ store, deliver: async () => {}, batchLimit: 1 });

  assert.equal(result.claimed, 1);
  assert.equal(result.stopReason, "batch-failed");
  assert.equal(result.errorName, "Error");
});

test("a delivery failure is counted, not thrown", async () => {
  const store = endlessStore(2);
  const failures: unknown[] = [];
  const result = await runOutboxDrain({
    store,
    deliver: async () => {
      throw new Error("provider refused");
    },
    batchLimit: 1,
    onDeliveryFailure: (failure) => failures.push(failure),
  });

  assert.equal(result.claimed, 2);
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 2);
  assert.equal(result.stopReason, "empty");
  assert.equal(failures.length, 2);
});

test("invalid settings are rejected before the store is touched", async () => {
  let claims = 0;
  const store = {
    async claimOutboxEvents() {
      claims += 1;
      return [];
    },
    async markOutboxDelivered() {
      throw new Error("must not mark");
    },
    async rescheduleOutboxEvent() {
      throw new Error("must not reschedule");
    },
  } as unknown as Store;

  for (const invalid of [
    { batchLimit: 0 },
    { batchLimit: 101 },
    { leaseSeconds: 0 },
    { leaseSeconds: 3601 },
    { retryDelaySeconds: 0 },
    { retryDelaySeconds: 86_401 },
    { deadlineMs: 0 },
    { deadlineMs: 600_001 },
    { maxBatches: 0 },
    { maxBatches: 1001 },
    { maxBatches: 1.5 },
  ]) {
    await assert.rejects(runOutboxDrain({ store, deliver: async () => {}, ...invalid }), TypeError);
  }
  assert.equal(claims, 0);
});

test("the composed SQLite adapter drains real outbox rows in bounded batches", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const store = createSqliteStore(db);
  const conversation = await store.createConversation({ actorId: "alice", participantIds: ["bob"] });
  for (const key of ["drain-message-1", "drain-message-2", "drain-message-3"]) {
    await store.persistMessage({
      conversationId: conversation.id,
      senderId: "alice",
      body: `A message drained by the one-shot path (${key}).`,
      idempotencyKey: key,
    });
  }

  const delivered: string[] = [];
  const result = await runOutboxDrain({
    store,
    deliver: async (event) => {
      delivered.push(event.event_key);
    },
    batchLimit: 2,
  });

  assert.equal(result.claimed, 3);
  assert.equal(result.delivered, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.stopReason, "empty");
  assert.equal(result.errorName, null);
  // Two events, then one, then the empty batch that proves the outbox is drained.
  assert.equal(result.batches, 3);
  assert.equal(delivered.length, 3);
  assert.equal(new Set(delivered).size, 3, "each persisted event is delivered exactly once");
  assert.ok(delivered.every((key) => key.startsWith("message:")), `unexpected event keys: ${delivered.join(", ")}`);
});
