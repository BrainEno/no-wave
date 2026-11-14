import { randomUUID } from "node:crypto";
import { assertOutboxLease } from "./outbox-lease.ts";
import { DEFAULT_OUTBOX_MAX_ATTEMPTS, validateOutboxMaxAttempts } from "./outbox-retry-policy.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, type CapturedChange } from "./sqlite-provider-migration-capture.ts";
import type { StoredOutboxEvent, TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import type { SqliteRow, SqliteRunner } from "./sqlite.ts";

/** SQLite transactional outbox store with fenced leases and durable terminal states. */
export function createSqliteOutboxStore(db: SqliteRunner) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") throw new TypeError("A SQLite database connection is required.");
  const get = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args);
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
  function one(sql: string, ...args: unknown[]): SqliteRow {
    const row = get(sql, ...args);
    if (!row) throw new Error("Expected a row for the migration capture: " + sql);
    return row;
  }
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  return Object.freeze({
    async claimOutboxEvents({ limit = 25, leaseSeconds = 60, maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
      validateOutboxMaxAttempts(maxAttempts);
      const transactionId = createMigrationTransactionId();
      const changes: CapturedChange[] = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        // A process can die on its last attempt without running the failure
        // callback. Quarantine expired, exhausted leases before looking for work.
        // Bound this maintenance independently; a large poison backlog cannot
        // make a claim unbounded or prevent a healthy row from being selected.
        const now = Date.now(), nowIso = new Date(now).toISOString();
        const exhausted = all(
          "UPDATE outbox_events SET dead_lettered_at=?,lease_token=NULL WHERE id IN (SELECT id FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= ? AND attempts >= ? ORDER BY created_at,id LIMIT 100) RETURNING id",
          nowIso, nowIso, maxAttempts,
        );
        for (const row of exhausted) changes.push({
          entityType: "outbox_events", entityId: row.id, operation: "upsert",
          payload: one("SELECT * FROM outbox_events WHERE id = ?", row.id),
        });
        // Compute the lease after acquiring the writer lock, never before it.
        const leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();
        const candidates = all("SELECT id FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts < ? AND available_at <= ? ORDER BY created_at,id LIMIT ?", maxAttempts, nowIso, limit);
        const update = db.prepare("UPDATE outbox_events SET attempts=attempts+1,available_at=?,lease_token=? WHERE id=? AND delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= ?");
        const claimed: StoredOutboxEvent[] = [];
        for (const item of candidates) {
          const result = update.run(leaseUntil, randomUUID(), item.id, nowIso);
          if (!result.changes) continue;
          const row = one("SELECT * FROM outbox_events WHERE id=?", item.id);
          claimed.push({
            id: String(row.id), event_key: String(row.event_key), event_type: String(row.event_type),
            aggregate_id: String(row.aggregate_id), payload: JSON.parse(String(row.payload)),
            attempts: Number(row.attempts), available_at: new Date(String(row.available_at)).toISOString(),
            lease_token: String(row.lease_token),
          });
          changes.push({ entityType: "outbox_events", entityId: item.id, operation: "upsert", payload: row });
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
        const result = run("UPDATE outbox_events SET delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_token=NULL WHERE id=? AND lease_token=? AND delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')", eventId, leaseToken.toLowerCase());
        if (result.changes === 1) migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "outbox_events", entityId: eventId, operation: "upsert", payload: one("SELECT * FROM outbox_events WHERE id = ?", eventId) },
        ]);
        db.exec("COMMIT");
        return result.changes === 1;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    },
    async rescheduleOutboxEvent({ eventId, leaseToken, delaySeconds = 30, maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS }) {
      assertOutboxLease(eventId, leaseToken);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new TypeError("delaySeconds must be an integer between 1 and 86400.");
      validateOutboxMaxAttempts(maxAttempts);
      const transactionId = createMigrationTransactionId();
      db.exec("BEGIN IMMEDIATE");
      try {
        // Decide from the persisted attempt count under the same write lock as
        // the lease check. A caller cannot accidentally retry an exhausted row.
        const result = run(
          "UPDATE outbox_events SET dead_lettered_at=CASE WHEN attempts >= ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,available_at=CASE WHEN attempts >= ? THEN available_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now',?) END,lease_token=NULL WHERE id=? AND lease_token=? AND delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
          maxAttempts, maxAttempts, "+" + delaySeconds + " seconds", eventId, leaseToken.toLowerCase(),
        );
        if (result.changes === 1) migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "outbox_events", entityId: eventId, operation: "upsert", payload: one("SELECT * FROM outbox_events WHERE id = ?", eventId) },
        ]);
        db.exec("COMMIT");
        return result.changes === 1;
      } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    },
    async outboxBacklog() {
      const row = get(
        "SELECT count(*) AS pending_events,MIN(created_at) AS oldest_created_at,(SELECT count(*) FROM outbox_events WHERE dead_lettered_at IS NOT NULL) AS dead_letter_events FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL",
      );
      const oldest = row?.oldest_created_at ? new Date(String(row.oldest_created_at)).getTime() : NaN;
      return {
        pendingEvents: Number(row?.pending_events ?? 0),
        deadLetterEvents: Number(row?.dead_letter_events ?? 0),
        oldestPendingAgeMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
      };
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "claimOutboxEvents" | "markOutboxDelivered" | "rescheduleOutboxEvent" | "outboxBacklog">;
}
