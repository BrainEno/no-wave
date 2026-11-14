/** PostgreSQL transactional outbox leasing, acknowledgement and backlog metrics. */
import { assertOutboxLease } from "./outbox-lease.ts";
import { DEFAULT_OUTBOX_MAX_ATTEMPTS, validateOutboxMaxAttempts } from "./outbox-retry-policy.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { CapturedChange } from "./postgres-provider-migration-capture.ts";
import { isoDate, parseJsonValue, type PostgresStoreContext } from "./postgres-shared.ts";
import type { StoredOutboxEvent, TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

type ClaimedOutboxRow = {
  id: string; event_key: string; event_type: string; aggregate_id: string;
  payload: unknown; attempts: number; available_at: string | Date; lease_token: string;
};
function mapClaimedOutboxEvent(row: ClaimedOutboxRow): StoredOutboxEvent {
  return {
    id: row.id, event_key: row.event_key, event_type: row.event_type,
    aggregate_id: row.aggregate_id, payload: parseJsonValue(row.payload),
    attempts: Number(row.attempts), available_at: isoDate(row.available_at), lease_token: row.lease_token,
  };
}

export function createPostgresOutboxStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
    async claimOutboxEvents({ limit = 25, leaseSeconds = 60, maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
      validateOutboxMaxAttempts(maxAttempts);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        // Recover final attempts abandoned by a crashed worker, but do not wait
        // for live writers or sweep an unbounded poison backlog in one claim.
        const exhausted = await tx.unsafe(
          "WITH picked AS ( SELECT id FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND available_at <= clock_timestamp() AND attempts >= $1 ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED ) " +
          "UPDATE outbox_events AS event SET dead_lettered_at=clock_timestamp(),lease_token=NULL FROM picked WHERE event.id=picked.id RETURNING event.id",
          [maxAttempts],
        );
        const rows = await tx.unsafe<ClaimedOutboxRow>(
          "WITH picked AS ( SELECT id FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND attempts < $3 AND available_at <= clock_timestamp() ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED ) " +
          "UPDATE outbox_events AS event SET attempts=event.attempts+1,available_at=clock_timestamp()+($2 * interval '1 second'),lease_token=gen_random_uuid() FROM picked WHERE event.id=picked.id " +
          "RETURNING event.id,event.event_key,event.event_type,event.aggregate_id,event.payload,event.attempts,event.available_at,event.lease_token",
          [limit, leaseSeconds, maxAttempts],
        );
        const changes: CapturedChange[] = [];
        for (const row of [...exhausted, ...rows]) {
          const snapshot = await tx.unsafe("SELECT * FROM outbox_events WHERE id=$1", [row.id]);
          if (snapshot[0]) changes.push({ entityType: "outbox_events", entityId: row.id, operation: "upsert", payload: snapshot[0] });
        }
        await captureChanges(tx, transactionId, changes);
        return rows.map(mapClaimedOutboxEvent);
      });
    },
    async markOutboxDelivered({ eventId, leaseToken }) {
      assertOutboxLease(eventId, leaseToken);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "WITH locked AS MATERIALIZED ( SELECT id,lease_token,available_at,delivered_at,dead_lettered_at FROM outbox_events WHERE id=$1 FOR UPDATE ) " +
          "UPDATE outbox_events AS event SET delivered_at=clock_timestamp(),lease_token=NULL FROM locked " +
          "WHERE event.id=locked.id AND locked.delivered_at IS NULL AND locked.dead_lettered_at IS NULL AND locked.lease_token=$2 AND locked.available_at > clock_timestamp() RETURNING event.id",
          [eventId, leaseToken],
        );
        if (rows.length === 1) {
          const snapshot = await tx.unsafe("SELECT * FROM outbox_events WHERE id=$1", [eventId]);
          await captureChanges(tx, transactionId, [{ entityType: "outbox_events", entityId: eventId, operation: "upsert", payload: snapshot[0] }]);
        }
        return rows.length === 1;
      });
    },
    async rescheduleOutboxEvent({ eventId, leaseToken, delaySeconds = 30, maxAttempts = DEFAULT_OUTBOX_MAX_ATTEMPTS }) {
      assertOutboxLease(eventId, leaseToken);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new TypeError("delaySeconds must be an integer between 1 and 86400.");
      validateOutboxMaxAttempts(maxAttempts);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "WITH locked AS MATERIALIZED ( SELECT id,lease_token,available_at,delivered_at,dead_lettered_at,attempts FROM outbox_events WHERE id=$1 FOR UPDATE ) " +
          "UPDATE outbox_events AS event SET dead_lettered_at=CASE WHEN locked.attempts >= $4 THEN clock_timestamp() ELSE NULL END," +
          "available_at=CASE WHEN locked.attempts >= $4 THEN locked.available_at ELSE clock_timestamp()+($3 * interval '1 second') END,lease_token=NULL FROM locked " +
          "WHERE event.id=locked.id AND locked.delivered_at IS NULL AND locked.dead_lettered_at IS NULL AND locked.lease_token=$2 AND locked.available_at > clock_timestamp() RETURNING event.id",
          [eventId, leaseToken, delaySeconds, maxAttempts],
        );
        if (rows.length === 1) {
          const snapshot = await tx.unsafe("SELECT * FROM outbox_events WHERE id=$1", [eventId]);
          await captureChanges(tx, transactionId, [{ entityType: "outbox_events", entityId: eventId, operation: "upsert", payload: snapshot[0] }]);
        }
        return rows.length === 1;
      });
    },
    async outboxBacklog() {
      const [row] = await sql.unsafe(
        "SELECT count(*)::bigint AS pending_events,MIN(created_at) AS oldest_created_at," +
        "(SELECT count(*)::bigint FROM outbox_events WHERE dead_lettered_at IS NOT NULL) AS dead_letter_events " +
        "FROM outbox_events WHERE delivered_at IS NULL AND dead_lettered_at IS NULL",
      );
      const oldest = row?.oldest_created_at ? new Date(row.oldest_created_at).getTime() : NaN;
      return {
        pendingEvents: Number(row?.pending_events ?? 0),
        deadLetterEvents: Number(row?.dead_letter_events ?? 0),
        oldestPendingAgeMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
      };
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "claimOutboxEvents" | "markOutboxDelivered" | "rescheduleOutboxEvent" | "outboxBacklog">;
}
