import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresOutboxStore } from "./postgres-outbox-store.ts";
import { createSqliteClient, runSqliteMigrations } from "./sqlite.ts";
import { createSqliteStore } from "./sqlite-store.ts";

/**
 * `StoredOutboxEvent` promises an ISO `available_at` string. PostgreSQL's
 * driver decodes `timestamptz` into a `Date`, and the leasing slice used to
 * return those raw rows. These two tests pin the observable result shape at the
 * cheapest reliable layer: a fake driver for PostgreSQL (no database needed)
 * and an in-memory SQLite adapter for the other provider.
 */
const AVAILABLE_AT = "2026-01-02T03:04:05.678Z";

function assertClaimedEventShape(event: unknown): void {
  assert.ok(event && typeof event === "object");
  const row = event as Record<string, unknown>;
  for (const field of ["id", "event_key", "event_type", "aggregate_id", "lease_token"]) {
    assert.equal(typeof row[field], "string", `${field} must be a string`);
  }
  assert.equal(typeof row.attempts, "number", "attempts must be a number");
  assert.ok(row.payload !== null && typeof row.payload === "object", "payload must be a decoded object");
  assert.equal(typeof row.available_at, "string", "available_at must be an ISO string, not the driver's Date");
  assert.equal(row.available_at, new Date(String(row.available_at)).toISOString());
}

test("PostgreSQL outbox leasing normalizes the driver's timestamptz Date into the contract's ISO string", async () => {
  const driverRow = {
    id: "event-id", event_key: "message:msg-id", event_type: "message.created",
    aggregate_id: "msg-id", payload: { messageId: "msg-id" }, attempts: 1,
    available_at: new Date(AVAILABLE_AT), lease_token: "lease-token",
  };
  const transaction = {
    async unsafe(query: string) {
      if (query.includes("SET dead_lettered_at")) return [];
      if (query.includes("RETURNING")) return [driverRow];
      if (query.includes("SELECT * FROM outbox_events")) return [{ ...driverRow }];
      return [];
    },
  };
  const sql = {
    async unsafe() { return []; },
    async begin<T>(work: (tx: typeof transaction) => T | Promise<T>): Promise<T> { return work(transaction); },
    async end() {},
  };
  let captured = 0;
  const store = createPostgresOutboxStore({
    sql,
    async captureChanges(_tx, _transactionId, changes) { captured = changes.length; },
  });

  const events = await store.claimOutboxEvents({ limit: 1, leaseSeconds: 60 });
  assert.equal(events.length, 1);
  assertClaimedEventShape(events[0]);
  assert.equal(events[0].available_at, AVAILABLE_AT);
  assert.equal(captured, 1, "the migration journal still sees the claimed row");
});

test("SQLite outbox leasing exposes the same declared result shape", async () => {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  try {
    const store = createSqliteStore(db);
    const conversation = await store.createConversation({ actorId: "alice", participantIds: ["bob"] });
    await store.persistMessage({
      conversationId: conversation.id, senderId: "alice", body: "shape check",
      idempotencyKey: "outbox-shape-key",
    });
    const events = await store.claimOutboxEvents({ limit: 1, leaseSeconds: 60 });
    assert.equal(events.length, 1);
    assertClaimedEventShape(events[0]);
  } finally {
    db.close();
  }
});
