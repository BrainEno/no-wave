import { randomUUID } from "node:crypto";
import { assertOutboxLease } from "./outbox-lease.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import {
  createSqliteProviderMigrationCapture,
  type CapturedChange,
} from "./sqlite-provider-migration-capture.ts";
import type { StoredOutboxEvent, TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { SqliteRow, SqliteRunner } from "./sqlite.ts";

/** SQLite transactional outbox store with lease-based claims and retry scheduling. */
export function createSqliteOutboxStore(db: SqliteRunner) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite database connection is required.");
  const get = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args);
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);

  /** The row a capture just wrote; a missing one is a bug, not a valid payload. */
  function one(sql: string, ...args: unknown[]): SqliteRow {
    const row = get(sql, ...args);
    if (!row) throw new Error("Expected a row for the migration capture: " + sql);
    return row;
  }

  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  return Object.freeze({
    async claimOutboxEvents({ limit = 25, leaseSeconds = 60 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
      const transactionId = createMigrationTransactionId();
      const changes: CapturedChange[] = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        // Compute the lease after acquiring the write lock, not before waiting
        // on another SQLite writer.
        const now = Date.now(), leaseUntil = new Date(now + leaseSeconds * 1000).toISOString(), nowIso = new Date(now).toISOString();
        const candidates = all("SELECT id FROM outbox_events WHERE delivered_at IS NULL AND available_at <= ? ORDER BY created_at,id LIMIT ?", nowIso, limit);
        const update = db.prepare("UPDATE outbox_events SET attempts=attempts+1,available_at=?,lease_token=? WHERE id=? AND delivered_at IS NULL AND available_at <= ?");
        const claimed: StoredOutboxEvent[] = [];
        for (const item of candidates) {
          const result = update.run(leaseUntil, randomUUID(), item.id, nowIso);
          if (!result.changes) continue;
          const row = get("SELECT id,event_key,event_type,aggregate_id,payload,attempts,available_at,lease_token FROM outbox_events WHERE id=?", item.id);
          const snapshot = get("SELECT * FROM outbox_events WHERE id = ?", item.id);
          if (row) {
            claimed.push({
              id: String(row.id),
              event_key: String(row.event_key),
              event_type: String(row.event_type),
              aggregate_id: String(row.aggregate_id),
              payload: JSON.parse(String(row.payload)),
              attempts: Number(row.attempts),
              available_at: new Date(String(row.available_at)).toISOString(),
              lease_token: String(row.lease_token),
            });
          }
          if (snapshot) changes.push({ entityType: "outbox_events", entityId: item.id, operation: "upsert" as const, payload: snapshot });
        }
        migrationCapture.captureInTransaction(db, transactionId, changes);
        db.exec("COMMIT");
        return claimed;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    },
    async markOutboxDelivered({ eventId, leaseToken }) {
      assertOutboxLease(eventId, leaseToken);
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = run("UPDATE outbox_events SET delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_token=NULL WHERE id=? AND lease_token=? AND delivered_at IS NULL AND available_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')", eventId, leaseToken.toLowerCase());
        if (result.changes === 1) migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "outbox_events", entityId: eventId, operation: "upsert" as const, payload: one("SELECT * FROM outbox_events WHERE id = ?", eventId) },
        ]);
        db.exec("COMMIT");
        return result.changes === 1;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    },
    async rescheduleOutboxEvent({ eventId, leaseToken, delaySeconds = 30 }) {
      assertOutboxLease(eventId, leaseToken);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new TypeError("delaySeconds must be an integer between 1 and 86400.");
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = run("UPDATE outbox_events SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),lease_token=NULL WHERE id=? AND lease_token=? AND delivered_at IS NULL AND available_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')", "+" + delaySeconds + " seconds", eventId, leaseToken.toLowerCase());
        if (result.changes === 1) migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "outbox_events", entityId: eventId, operation: "upsert" as const, payload: one("SELECT * FROM outbox_events WHERE id = ?", eventId) },
        ]);
        db.exec("COMMIT");
        return result.changes === 1;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    },
    /**
     * How much undelivered work the outbox is holding, in one row.
     *
     * The worker's backlog gauges are the only thing that says "delivery has
     * been broken since Tuesday", so they must work on every provider the drain
     * can run against — which is why this is a port method rather than a
     * PostgreSQL-only query inside the worker.
     */
    async outboxBacklog() {
      const row = get(
        "SELECT count(*) AS pending_events, MIN(created_at) AS oldest_created_at FROM outbox_events WHERE delivered_at IS NULL",
      );
      const oldest = row && row.oldest_created_at ? new Date(String(row.oldest_created_at)).getTime() : NaN;
      const pending = Number(row?.pending_events);
      return {
        pendingEvents: Number.isFinite(pending) ? pending : 0,
        oldestPendingAgeMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
      };
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "claimOutboxEvents" | "markOutboxDelivered" | "rescheduleOutboxEvent" | "outboxBacklog">;
}
