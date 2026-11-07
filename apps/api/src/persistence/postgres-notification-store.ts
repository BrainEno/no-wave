/**
 * PostgreSQL persistence slice: Recipient-scoped notification inbox and message delivery.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import { randomUUID } from "node:crypto";
import { IdempotencyConflictError, InvalidMessageCursorError } from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { parseJsonValue, requestHash } from "./postgres-shared.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { CapturedChange } from "./postgres-provider-migration-capture.ts";
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

export function createPostgresNotificationStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
    async listNotifications({ actorId, limit = 50 }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        "SELECT id, user_id, event_key, payload, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
        [actorId, limit],
      );
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        eventKey: row.event_key,
        payload: parseJsonValue(row.payload),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        readAt: row.read_at == null ? null : (row.read_at instanceof Date ? row.read_at.toISOString() : new Date(row.read_at).toISOString()),
      }));
    },

    async getUnreadNotificationCount({ actorId }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      const rows = await sql.unsafe(
        "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [actorId],
      );
      return rows[0].count;
    },

    async markAllNotificationsRead({ actorId }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING *",
          [actorId],
        );
        await captureChanges(tx, transactionId, rows.map((row) => ({ entityType: "notifications", entityId: row.id, operation: "upsert" as const, payload: row })));
        return rows.length;
      });
    },

    async markNotificationRead({ notificationId, actorId }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      if (!isUuid(notificationId)) {
        throw new InvalidMessageCursorError("notificationId must be a valid notification ID.");
      }
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const before = await tx.unsafe("SELECT read_at FROM notifications WHERE id = $1 AND user_id = $2 FOR UPDATE", [notificationId, actorId]);
        const rows = await tx.unsafe(
          "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id, user_id, event_key, payload, created_at, read_at",
          [notificationId, actorId],
        );
        const row = rows[0];
        if (!row) return null;
        if (before[0]?.read_at == null) {
          const snapshots = await tx.unsafe("SELECT * FROM notifications WHERE id = $1", [notificationId]);
          await captureChanges(tx, transactionId, [{ entityType: "notifications", entityId: notificationId, operation: "upsert", payload: snapshots[0] }]);
        }
        return {
          id: row.id,
          userId: row.user_id,
          eventKey: row.event_key,
          payload: parseJsonValue(row.payload),
          createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
          readAt: row.read_at instanceof Date ? row.read_at.toISOString() : new Date(row.read_at).toISOString(),
        };
      });
    },

    async createNotification({ userId, eventKey, payload }) {
      for (const [name, value] of Object.entries({ userId, eventKey })) {
        if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
          throw new TypeError(`${name} must be a non-empty, trimmed string.`);
        }
      }
      if (payload === undefined) throw new TypeError("payload is required.");
      const hash = requestHash(payload);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const inserted = await tx.unsafe(
          "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id, user_id, event_key, payload, created_at, payload_hash",
          [randomUUID(), userId, eventKey, payload, hash],
        );
        let row = inserted[0];
        let duplicate = false;
        if (row) await captureChanges(tx, transactionId, [
          { entityType: "notifications", entityId: row.id, operation: "upsert", payload: row },
        ]);
        if (!row) {
          const existing = await tx.unsafe(
            "SELECT id, user_id, event_key, payload, created_at, payload_hash FROM notifications WHERE user_id = $1 AND event_key = $2",
            [userId, eventKey],
          );
          row = existing[0];
          if (!row) throw new Error("Notification idempotency row disappeared during transaction.");
          if (row.payload_hash !== hash) throw new IdempotencyConflictError("The notification event key was already used with a different payload.");
          duplicate = true;
        }
        return { id: row.id, userId: row.user_id, eventKey: row.event_key, payload: parseJsonValue(row.payload), createdAt: row.created_at, duplicate };
      });
    },

    /**
     * Many inbox rows, one transaction (audit F-23).
     *
     * Same semantics as the single call, one row at a time inside one
     * transaction: a duplicate key is reported as `duplicate: true`, the same key
     * with a different payload raises `IdempotencyConflictError`, and a failure
     * anywhere rolls the whole batch back. Receipts are returned in input order.
     */
    async createNotifications(inputs) {
      if (!Array.isArray(inputs)) throw new TypeError("createNotifications expects an array of notification inputs.");
      if (inputs.length === 0) return [];
      const prepared = inputs.map(({ userId, eventKey, payload }) => {
        for (const [name, value] of Object.entries({ userId, eventKey })) {
          if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
            throw new TypeError(`${name} must be a non-empty, trimmed string.`);
          }
        }
        if (payload === undefined) throw new TypeError("payload is required.");
        return { userId, eventKey, payload, hash: requestHash(payload) };
      });
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const changes: CapturedChange[] = [];
        const receipts = [];
        for (const { userId, eventKey, payload, hash } of prepared) {
          const inserted = await tx.unsafe(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id, user_id, event_key, payload, created_at, payload_hash",
            [randomUUID(), userId, eventKey, payload, hash],
          );
          let row = inserted[0];
          let duplicate = false;
          if (row) {
            changes.push({ entityType: "notifications", entityId: row.id, operation: "upsert", payload: row });
          } else {
            const existing = await tx.unsafe(
              "SELECT id, user_id, event_key, payload, created_at, payload_hash FROM notifications WHERE user_id = $1 AND event_key = $2",
              [userId, eventKey],
            );
            row = existing[0];
            if (!row) throw new Error("Notification idempotency row disappeared during transaction.");
            if (row.payload_hash !== hash) throw new IdempotencyConflictError("The notification event key was already used with a different payload.");
            duplicate = true;
          }
          receipts.push({
            id: row.id,
            userId: row.user_id,
            eventKey: row.event_key,
            payload: parseJsonValue(row.payload),
            createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
            duplicate,
          });
        }
        await captureChanges(tx, transactionId, changes);
        return receipts;
      });
    },

    async deliverMessageNotifications({ eventKey, messageId, conversationId, senderId }) {
      for (const [name, value] of Object.entries({ eventKey, conversationId, senderId })) requiredText(name, value, 300);
      if (!isUuid(messageId)) throw new TypeError("messageId must be a valid UUID.");
      const payload = { type: "message.created", messageId, conversationId, senderId };
      const hash = requestHash(payload);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const changes: CapturedChange[] = [];
        // All membership edits and deletes lock this same row first. A stale
        // event whose conversation has been deleted is a harmless no-op.
        const conversation = await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversation[0]) return false;
        const messages = await tx.unsafe(
          "SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND sender_id = $3",
          [messageId, conversationId, senderId],
        );
        if (!messages[0]) throw new Error("Message notification event does not match a persisted message.");
        const participants = await tx.unsafe(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL AND user_id <> $2 ORDER BY user_id",
          [conversationId, senderId],
        );
        for (const { user_id: userId } of participants) {
          const notificationId = randomUUID();
          const inserted = await tx.unsafe(
            "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id",
            [notificationId, userId, eventKey, payload, hash],
          );
          if (inserted.length === 1) {
            const snapshot = await tx.unsafe("SELECT * FROM notifications WHERE id = $1", [notificationId]);
            if (snapshot[0]) changes.push({ entityType: "notifications", entityId: notificationId, operation: "upsert", payload: snapshot[0] });
          }
          if (inserted.length === 0) {
            const existing = await tx.unsafe(
              "SELECT payload_hash FROM notifications WHERE user_id = $1 AND event_key = $2",
              [userId, eventKey],
            );
            if (!existing[0]) throw new Error("Notification idempotency row disappeared during transaction.");
            if (existing[0].payload_hash !== hash) throw new IdempotencyConflictError("The notification event key was already used with a different payload.");
          }
        }
        await captureChanges(tx, transactionId, changes);
        return true;
      });
    },

  }) satisfies Pick<TypedPersistenceAdapterContract, "listNotifications" | "getUnreadNotificationCount" | "markAllNotificationsRead" | "markNotificationRead" | "createNotification" | "createNotifications" | "deliverMessageNotifications">;
}
