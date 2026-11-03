import { createHash, randomUUID } from "node:crypto";
import {
  articleIdempotencyFingerprint,
  articleIdempotencyKeyHash,
  articleIdempotencyReplayMatches,
} from "../application/article-idempotency.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createPostgresProviderMigrationCapture, migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import {
  IdempotencyConflictError,
  ConversationAccessError,
  ConversationInputError,
  ConversationNotFoundError,
  InvalidMessageCursorError,
  ArticleInputError,
  ArticleSlugConflictError,
  ArticleAuthorizationError,
  ArticleNotFoundError,
  ProfileInputError,
  ProfileNotFoundError,
  TaxonomyConflictError,
  TaxonomyNotFoundError,
} from "../domain/errors.ts";
import { normalizeHashtag, validateTaxonomyKind } from "../domain/taxonomy.ts";
import {
  validateArticleLocale,
  validateArticleSlug,
  normalizeArticleInput,
  normalizeTaxonomyIds,
  MAX_FEATURED_ARTICLES,
  resolveArticleCursor,
} from "../domain/article.ts";
import {
  AUTHOR_OFFSET_MAX,
  AUTHOR_QUERY_MAX_LENGTH,
  normalizeStoredRole,
  validateUserRole,
} from "../domain/profile.ts";
import { validateStoredCommentContent } from "../domain/comment-content.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { normalizeParticipantIds } from "../domain/conversation.ts";
import { validateProfileUrl } from "../domain/profile.ts";
import { assertOutboxLease } from "./outbox-lease.ts";
import { requestHash, parseJsonValue, isoDate } from "./postgres-helpers.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";



export function createPostgresOutboxStore(sql: any): Partial<TypedPersistenceAdapterContract> {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js SQL client is required.");
  }
  const migrationCapture = createPostgresProviderMigrationCapture(sql);
    async function captureChanges(tx, transactionId, changes) {
    await migrationCapture.captureInTransaction(tx, transactionId, changes);
  }

  return Object.freeze({
        async claimOutboxEvents({ limit = 25, leaseSeconds = 60 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "WITH picked AS ( SELECT id FROM outbox_events WHERE delivered_at IS NULL AND available_at <= now() ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED ) " +
          "UPDATE outbox_events AS event SET attempts = event.attempts + 1, available_at = clock_timestamp() + ($2 * interval '1 second'), lease_token = gen_random_uuid() " +
          "FROM picked WHERE event.id = picked.id " +
          "RETURNING event.id, event.event_key, event.event_type, event.aggregate_id, event.payload, event.attempts, event.available_at, event.lease_token",
          [limit, leaseSeconds],
        );
        const changes = [];
        for (const row of rows) {
          const snapshot = await tx.unsafe("SELECT * FROM outbox_events WHERE id = $1", [row.id]);
          if (snapshot[0]) changes.push({ entityType: "outbox_events", entityId: row.id, operation: "upsert" as const, payload: snapshot[0] });
        }
        await captureChanges(tx, transactionId, changes);
        return rows;
      });
    },
        async markOutboxDelivered({ eventId, leaseToken }) {
      assertOutboxLease(eventId, leaseToken);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "WITH locked AS MATERIALIZED ( SELECT id, lease_token, available_at, delivered_at FROM outbox_events WHERE id = $1 FOR UPDATE ) " +
          "UPDATE outbox_events AS event SET delivered_at = clock_timestamp(), lease_token = NULL FROM locked " +
          "WHERE event.id = locked.id AND locked.delivered_at IS NULL AND locked.lease_token = $2 AND locked.available_at > clock_timestamp() " +
          "RETURNING event.id",
          [eventId, leaseToken],
        );
        if (rows.length === 1) {
          const snapshot = await tx.unsafe("SELECT * FROM outbox_events WHERE id = $1", [eventId]);
          await captureChanges(tx, transactionId, [{ entityType: "outbox_events", entityId: eventId, operation: "upsert", payload: snapshot[0] }]);
        }
        return rows.length === 1;
      });
    },
        async rescheduleOutboxEvent({ eventId, leaseToken, delaySeconds = 30 }) {
      assertOutboxLease(eventId, leaseToken);
      if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new TypeError("delaySeconds must be an integer between 1 and 86400.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "WITH locked AS MATERIALIZED ( SELECT id, lease_token, available_at, delivered_at FROM outbox_events WHERE id = $1 FOR UPDATE ) " +
          "UPDATE outbox_events AS event SET available_at = clock_timestamp() + ($3 * interval '1 second'), lease_token = NULL FROM locked " +
          "WHERE event.id = locked.id AND locked.delivered_at IS NULL AND locked.lease_token = $2 AND locked.available_at > clock_timestamp() " +
          "RETURNING event.id",
          [eventId, leaseToken, delaySeconds],
        );
        if (rows.length === 1) {
          const snapshot = await tx.unsafe("SELECT * FROM outbox_events WHERE id = $1", [eventId]);
          await captureChanges(tx, transactionId, [{ entityType: "outbox_events", entityId: eventId, operation: "upsert", payload: snapshot[0] }]);
        }
        return rows.length === 1;
      });
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
      const rows = await sql.unsafe(
        "SELECT count(*)::bigint AS pending_events, MIN(created_at) AS oldest_created_at " +
        "FROM outbox_events WHERE delivered_at IS NULL",
        [],
      );
      const row = rows[0] ?? {};
      const oldest = row.oldest_created_at ? new Date(row.oldest_created_at).getTime() : NaN;
      return {
        pendingEvents: Number.isFinite(Number(row.pending_events)) ? Number(row.pending_events) : 0,
        oldestPendingAgeMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
      };
    },
  });
}
