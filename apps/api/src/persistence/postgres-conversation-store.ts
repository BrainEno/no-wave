/**
 * PostgreSQL persistence slice: Conversations, membership and message persistence.
 *
 * Composed by postgres.ts. Row mapping and shared SQL helpers live in
 * postgres-shared.ts so every slice reads rows the same way.
 */
import { randomUUID } from "node:crypto";
import { normalizeParticipantIds } from "../domain/conversation.ts";
import { ConversationAccessError, ConversationInputError, ConversationNotFoundError, IdempotencyConflictError, InvalidMessageCursorError } from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import { assertSameRequest, findConversationForMember, findMessage, isoDate, mapConversation, mapMessage, requestHash } from "./postgres-shared.ts";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import type { PostgresStoreContext } from "./postgres-shared.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";

export function createPostgresConversationStore(ctx: PostgresStoreContext) {
  const { sql, captureChanges } = ctx;
  return Object.freeze({
    async createConversation({ actorId, participantIds, idempotencyKey = null }) {
      requiredText("actorId", actorId, 300);
      const suppliedIds = normalizeParticipantIds("participantIds", participantIds, 20);
      const others = suppliedIds.filter((id) => id !== actorId);
      if (others.length === 0) throw new ConversationInputError("A conversation requires at least one other participant.");
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey)) {
        throw new ConversationInputError("Idempotency-Key must be a non-empty trimmed string no longer than 300 characters.");
      }
      const allIds = [actorId, ...others];
      const conversationId = randomUUID();
      const keyHash = idempotencyKey === null ? null : requestHash({
        method: "POST", route: "/api/v1/conversations", actorId, key: idempotencyKey,
      });
      const fingerprint = requestHash({ actorId, participantIds: [...allIds].sort() });
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        // A retried create is a replay, not a second conversation. Two writers
        // racing on the same key: one inserts, the other blocks on the unique
        // index and then reads back what the winner committed.
        const created = await tx.unsafe(
          "INSERT INTO conversations (id, created_by, idempotency_key_hash, request_hash) VALUES ($1, $2, $3, $4) " +
          "ON CONFLICT (created_by, idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL DO NOTHING " +
          "RETURNING id, created_by, created_at",
          [conversationId, actorId, keyHash, keyHash === null ? null : fingerprint],
        );
        if (created.length === 0) {
          const existing = await tx.unsafe(
            "SELECT id, request_hash FROM conversations WHERE created_by = $1 AND idempotency_key_hash = $2",
            [actorId, keyHash],
          );
          const row = existing[0];
          if (!row) throw new ConversationInputError("The conversation could not be created; retry the request.");
          if (row.request_hash !== fingerprint) {
            throw new IdempotencyConflictError("The idempotency key was already used for a different conversation request.");
          }
          return findConversationForMember(tx, { conversationId: row.id, actorId });
        }
        for (const userId of allIds) {
          await tx.unsafe(
            "INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, now())",
            [conversationId, userId],
          );
        }
        const row = created[0];
        const [conversationSnapshot, participantSnapshots] = await Promise.all([
          tx.unsafe("SELECT * FROM conversations WHERE id = $1", [conversationId]),
          tx.unsafe("SELECT * FROM conversation_participants WHERE conversation_id = $1 ORDER BY user_id", [conversationId]),
        ]);
        await captureChanges(tx, transactionId, [
          { entityType: "conversations", entityId: conversationId, operation: "upsert", payload: conversationSnapshot[0] },
          ...participantSnapshots.map((participant) => ({ entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, participant.user_id), operation: "upsert" as const, payload: participant })),
        ]);
        return {
          id: row.id,
          createdBy: row.created_by,
          participantIds: allIds,
          createdAt: isoDate(row.created_at),
          lastActivityAt: isoDate(row.created_at),
          unreadCount: 0,
          lastMessage: null,
        };
      });
    },

    async getConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return findConversationForMember(sql, { conversationId, actorId });
    },

    async updateConversationParticipants({ conversationId, actorId, addUserIds = [], removeUserIds = [] }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      const adds = normalizeParticipantIds("addUserIds", addUserIds, 20);
      const removes = normalizeParticipantIds("removeUserIds", removeUserIds, 20);
      if (removes.includes(actorId)) throw new ConversationInputError("The current user cannot remove themself; delete the conversation instead.");
      if (adds.some((id) => removes.includes(id))) throw new ConversationInputError("A user cannot be added and removed in the same operation.");
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const conversations = await tx.unsafe("SELECT created_by FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversations[0]) throw new ConversationNotFoundError();
        const membership = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, actorId],
        );
        if (membership.length === 0) throw new ConversationAccessError();
        if (conversations[0].created_by !== actorId) {
          throw new ConversationAccessError("Only the conversation creator can manage participants.");
        }
        if (removes.includes(conversations[0].created_by)) {
          throw new ConversationInputError("The conversation creator cannot be removed from its own conversation.");
        }
        for (const userId of adds) {
          await tx.unsafe(
            `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at, last_read_sequence)
             SELECT $1, $2, now(), last_message_sequence FROM conversations WHERE id = $1
             ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL,
               joined_at = CASE WHEN conversation_participants.left_at IS NOT NULL THEN now() ELSE conversation_participants.joined_at END,
               last_read_at = CASE WHEN conversation_participants.left_at IS NOT NULL THEN now() ELSE conversation_participants.last_read_at END,
               last_read_sequence = CASE WHEN conversation_participants.left_at IS NOT NULL THEN excluded.last_read_sequence ELSE conversation_participants.last_read_sequence END`,
            [conversationId, userId],
          );
        }
        for (const userId of removes) {
          await tx.unsafe(
            "UPDATE conversation_participants SET left_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
            [conversationId, userId],
          );
        }
        const changedIds = [...new Set([...adds, ...removes])];
        const snapshots = changedIds.length ? await tx.unsafe("SELECT * FROM conversation_participants WHERE conversation_id = $1 AND user_id = ANY($2::text[])", [conversationId, changedIds]) : [];
        await captureChanges(tx, transactionId, snapshots.map((participant) => ({
          entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, participant.user_id), operation: "upsert" as const, payload: participant,
        })));
        // Same answer as the SQLite slice: the active members after the update,
        // sorted by id. Read inside the write transaction so the caller sees
        // exactly what this transaction committed.
        const participants = await tx.unsafe<{ user_id: string }>(
          "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id",
          [conversationId],
        );
        return participants.map((participant) => participant.user_id);
      });
    },

    async deleteConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe("SELECT created_by FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!rows[0]) return false;
        if (rows[0].created_by !== actorId) {
          throw new ConversationAccessError("Only the conversation creator can delete this conversation.");
        }
        const membership = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, actorId],
        );
        if (membership.length === 0) throw new ConversationAccessError();
        const [participants, messages, outbox, notifications] = await Promise.all([
          tx.unsafe("SELECT * FROM conversation_participants WHERE conversation_id = $1", [conversationId]),
          tx.unsafe("SELECT * FROM messages WHERE conversation_id = $1", [conversationId]),
          tx.unsafe("SELECT * FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)", [conversationId]),
          tx.unsafe("SELECT * FROM notifications WHERE payload->>'conversationId' = $1 AND payload->>'type' = 'message.created'", [conversationId]),
        ]);
        await tx.unsafe(
          "DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id::text FROM messages WHERE conversation_id = $1)",
          [conversationId],
        );
        await tx.unsafe(
          "DELETE FROM notifications WHERE payload->>'conversationId' = $1 AND payload->>'type' = 'message.created'",
          [conversationId],
        );
        await tx.unsafe("DELETE FROM conversations WHERE id = $1", [conversationId]);
        await captureChanges(tx, transactionId, [
          { entityType: "conversations", entityId: conversationId, operation: "delete", payload: null },
          ...participants.map((row) => ({ entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, row.user_id), operation: "delete" as const, payload: null })),
          ...messages.map((row) => ({ entityType: "messages", entityId: row.id, operation: "delete" as const, payload: null })),
          ...outbox.map((row) => ({ entityType: "outbox_events", entityId: row.id, operation: "delete" as const, payload: null })),
          ...notifications.map((row) => ({ entityType: "notifications", entityId: row.id, operation: "delete" as const, payload: null })),
        ]);
        return true;
      });
    },

    async markConversationAsRead({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        // Reject non-members before taking (or waiting for) a private row lock.
        // Re-check in the UPDATE after locking: membership may change meanwhile.
        const member = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, actorId],
        );
        if (!member[0]) throw new ConversationAccessError();
        // Use the same per-conversation lock as sends, membership changes and
        // deletion. The mark includes every send committed before this lock,
        // but cannot swallow a send that commits after it.
        const conversation = await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversation[0]) throw new ConversationAccessError();
        const rows = await tx.unsafe(
          `UPDATE conversation_participants SET last_read_at = now(),
             last_read_sequence = (SELECT last_message_sequence FROM conversations WHERE id = $1)
           WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id`,
          [conversationId, actorId],
        );
        if (rows.length === 0) throw new ConversationAccessError();
        const snapshots = await tx.unsafe("SELECT * FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2", [conversationId, actorId]);
        await captureChanges(tx, transactionId, [
          { entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, actorId), operation: "upsert", payload: snapshots[0] },
        ]);
        return true;
      });
    },

    async listConversationMessages({ conversationId, actorId, limit = 100, before = null }) {
      for (const [name, value] of Object.entries({ conversationId, actorId })) {
        if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
          throw new TypeError(`${name} must be a non-empty, trimmed string.`);
        }
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      if (before !== null && !isUuid(before)) {
        throw new InvalidMessageCursorError("The message cursor must be a valid message ID.");
      }
      const membership = await sql.unsafe(
        "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
        [conversationId, actorId],
      );
      if (membership.length === 0) throw new ConversationAccessError();
      let rows;
      if (before === null) {
        rows = await sql.unsafe(
          "SELECT id, conversation_id, sender_id, body, created_at FROM (SELECT id, conversation_id, sender_id, body, created_at, conversation_sequence FROM messages WHERE conversation_id = $1 ORDER BY conversation_sequence DESC LIMIT $2) AS recent_messages ORDER BY conversation_sequence ASC",
          [conversationId, limit],
        );
      } else {
        const cursors = await sql.unsafe(
          "SELECT conversation_sequence FROM messages WHERE id = $1 AND conversation_id = $2",
          [before, conversationId],
        );
        if (cursors.length === 0) throw new InvalidMessageCursorError();
        rows = await sql.unsafe(
          "SELECT id, conversation_id, sender_id, body, created_at FROM (SELECT id, conversation_id, sender_id, body, created_at, conversation_sequence FROM messages WHERE conversation_id = $1 AND conversation_sequence < $3 ORDER BY conversation_sequence DESC LIMIT $2) AS older_messages ORDER BY conversation_sequence ASC",
          [conversationId, limit, cursors[0].conversation_sequence],
        );
      }
      return rows.map((row) => mapMessage(row));
    },

    async listConversations({ actorId, limit = 50 }) {
      if (typeof actorId !== "string" || actorId.trim().length === 0 || actorId !== actorId.trim()) {
        throw new TypeError("actorId must be a non-empty, trimmed string.");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      const rows = await sql.unsafe(
        `SELECT c.id, c.created_by, c.created_at,
                COALESCE(latest.created_at, c.created_at) AS last_activity_at,
                participants.user_ids AS participant_ids,
                latest.id AS latest_message_id,
                latest.conversation_id AS latest_message_conversation_id,
                latest.sender_id AS latest_message_sender_id,
                latest.body AS latest_message_body,
                latest.created_at AS latest_message_created_at,
                (SELECT count(*)::int FROM messages AS unread
                 WHERE unread.conversation_id = c.id
                   AND unread.sender_id <> $1
                   AND unread.conversation_sequence > membership.last_read_sequence) AS unread_count
         FROM conversation_participants AS membership
         JOIN conversations AS c ON c.id = membership.conversation_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM messages AS m
           WHERE m.conversation_id = c.id
           ORDER BY m.conversation_sequence DESC
           LIMIT 1
         ) AS latest ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(cp.user_id ORDER BY cp.user_id) AS user_ids
           FROM conversation_participants AS cp
           WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
         ) AS participants ON true
         WHERE membership.user_id = $1 AND membership.left_at IS NULL
         ORDER BY COALESCE(latest.created_at, c.created_at) DESC, c.id DESC
         LIMIT $2`,
        [actorId, limit],
      );
      return rows.map(mapConversation);
    },

    async persistMessage({ conversationId, senderId, body, idempotencyKey }) {
      for (const [name, value] of Object.entries({ conversationId, senderId, body, idempotencyKey })) {
        if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
          throw new TypeError(`${name} must be a non-empty, trimmed string.`);
        }
      }
      const hash = requestHash({ conversationId, senderId, body });
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        // Serialize the membership check and outbox insert with participant
        // changes, deletion and notification delivery, all of which lock this
        // conversation first. Otherwise a removed sender can still write or
        // deletion can sweep the outbox before an in-flight message commits.
        const conversation = await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
        if (!conversation[0]) throw new ConversationAccessError();
        const participants = await tx.unsafe(
          "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
          [conversationId, senderId],
        );
        if (participants.length === 0) throw new ConversationAccessError();
        const existing = await findMessage(tx, senderId, idempotencyKey);
        if (existing) return assertSameRequest(existing, hash);

        const inserted = await tx.unsafe(
          `INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash, conversation_sequence)
           SELECT $1, $2, $3, $4, $5, $6, last_message_sequence + 1 FROM conversations WHERE id = $2
           ON CONFLICT (sender_id, idempotency_key) DO NOTHING RETURNING *`,
          [randomUUID(), conversationId, senderId, body, idempotencyKey, hash],
        );
        if (inserted.length === 0) {
          const raced = await findMessage(tx, senderId, idempotencyKey);
          if (!raced) throw new Error("Idempotency conflict row disappeared during transaction.");
          return assertSameRequest(raced, hash);
        }
        const message = inserted[0];
        // Only advance the counter after a new insert; a raced idempotency-key
        // replay does not allocate a second message or move the read boundary.
        const conversationSnapshot = await tx.unsafe(
          "UPDATE conversations SET last_message_sequence = last_message_sequence + 1 WHERE id = $1 RETURNING *",
          [conversationId],
        );
        const outboxId = randomUUID();
        await tx.unsafe(
          "INSERT INTO outbox_events (id, event_key, event_type, aggregate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
          [outboxId, `message:${message.id}`, "message.created", message.id,
            { messageId: message.id, conversationId: message.conversation_id, senderId: message.sender_id }],
        );
        const outboxRows = await tx.unsafe("SELECT * FROM outbox_events WHERE id = $1", [outboxId]);
        await captureChanges(tx, transactionId, [
          { entityType: "conversations", entityId: conversationId, operation: "upsert", payload: conversationSnapshot[0] },
          { entityType: "messages", entityId: message.id, operation: "upsert", payload: message },
          { entityType: "outbox_events", entityId: outboxId, operation: "upsert", payload: outboxRows[0] },
        ]);
        return mapMessage(message, false);
      });
    },

    async listConversationParticipantIds({ conversationId }) {
      if (typeof conversationId !== "string" || conversationId.trim().length === 0 || conversationId !== conversationId.trim()) {
        throw new TypeError("conversationId must be a non-empty, trimmed string.");
      }
      const rows = await sql.unsafe(
        "SELECT user_id FROM conversation_participants WHERE conversation_id = $1 AND left_at IS NULL ORDER BY user_id",
        [conversationId],
      );
      return rows.map((row) => row.user_id);
    },

  }) satisfies Pick<TypedPersistenceAdapterContract, "createConversation" | "getConversation" | "updateConversationParticipants" | "deleteConversation" | "markConversationAsRead" | "listConversationMessages" | "listConversations" | "persistMessage" | "listConversationParticipantIds">;
}
