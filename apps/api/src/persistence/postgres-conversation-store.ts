import { randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { migrationEntityKey } from "./postgres-provider-migration-capture.ts";
import {
  IdempotencyConflictError,
  ConversationAccessError,
  ConversationInputError,
  ConversationNotFoundError,
  InvalidMessageCursorError
} from "../domain/errors.ts";
import { normalizeParticipantIds } from "../domain/conversation.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { isoDate, mapArticle, mapConversation, mapMessage, requestHash } from "./postgres-row-mappers.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-adapter.ts";

/**
 * PostgreSQL conversation slice: messages, membership, read state and the message outbox
 * intent — the counterpart of `sqlite-conversation-store.ts`.
 */
export function createPostgresConversationStore({ sql, captureChanges }): Pick<TypedPersistenceAdapterContract, "createConversation" | "updateConversationParticipants" | "deleteConversation" | "markConversationAsRead" | "listConversationMessages" | "getConversation" | "listConversations" | "persistMessage" | "listConversationParticipantIds"> {
  /**
   * One conversation as one of its active members sees it.
   *
   * The executor is a parameter so the same statement can run on the pool (a plain
   * read) and inside a `sql.begin` transaction (the replay path of
   * `createConversation`, which must see the row the competing writer committed).
   */
  const CONVERSATION_FOR_MEMBER_SQL = `SELECT c.id, c.created_by, c.created_at,
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
                     AND (membership.last_read_at IS NULL OR unread.created_at > membership.last_read_at)) AS unread_count
           FROM conversation_participants AS membership
           JOIN conversations AS c ON c.id = membership.conversation_id
           LEFT JOIN LATERAL (
             SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
             FROM messages AS m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT 1
           ) AS latest ON true
           LEFT JOIN LATERAL (
             SELECT array_agg(cp.user_id ORDER BY cp.user_id) AS user_ids
             FROM conversation_participants AS cp
             WHERE cp.conversation_id = c.id AND cp.left_at IS NULL
           ) AS participants ON true
           WHERE membership.user_id = $1 AND membership.conversation_id = $2 AND membership.left_at IS NULL
           LIMIT 1`;

  /**
   * One work as its author sees it, used to answer a replayed create with the work
   * it already made rather than with a frozen copy of the first response.
   */
  async function findConversationForMember(executor, { conversationId, actorId }) {
    const rows = await executor.unsafe(CONVERSATION_FOR_MEMBER_SQL, [actorId, conversationId]);
    return rows[0] ? mapConversation(rows[0]) : null;
  }

async function findMessage(tx, senderId, idempotencyKey) {
  const rows = await tx.unsafe(
    "SELECT id, conversation_id, sender_id, body, request_hash, created_at FROM messages WHERE sender_id = $1 AND idempotency_key = $2",
    [senderId, idempotencyKey],
  );
  return rows[0] ?? null;
}

function assertSameRequest(existing, hash) {
  if (existing.request_hash !== hash) throw new IdempotencyConflictError();
  return mapMessage(existing, true);
}

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
          ...participantSnapshots.map((participant) => ({ entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, participant.user_id), operation: "upsert", payload: participant })),
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
            "INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES ($1, $2, now()) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, joined_at = CASE WHEN conversation_participants.left_at IS NOT NULL THEN now() ELSE conversation_participants.joined_at END, last_read_at = CASE WHEN conversation_participants.left_at IS NOT NULL THEN now() ELSE conversation_participants.last_read_at END",
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
          entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, participant.user_id), operation: "upsert", payload: participant,
        })));
        return true;
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
          ...participants.map((row) => ({ entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, row.user_id), operation: "delete", payload: null })),
          ...messages.map((row) => ({ entityType: "messages", entityId: row.id, operation: "delete", payload: null })),
          ...outbox.map((row) => ({ entityType: "outbox_events", entityId: row.id, operation: "delete", payload: null })),
          ...notifications.map((row) => ({ entityType: "notifications", entityId: row.id, operation: "delete", payload: null })),
        ]);
        return true;
      });
    },
    async markConversationAsRead({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return sql.begin(async (tx) => {
        const transactionId = createMigrationTransactionId();
        const rows = await tx.unsafe(
          "UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING user_id",
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
          "SELECT id, conversation_id, sender_id, body, created_at FROM (SELECT id, conversation_id, sender_id, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) AS recent_messages ORDER BY created_at ASC, id ASC",
          [conversationId, limit],
        );
      } else {
        const cursors = await sql.unsafe(
          "SELECT id, created_at FROM messages WHERE id = $1 AND conversation_id = $2",
          [before, conversationId],
        );
        if (cursors.length === 0) throw new InvalidMessageCursorError();
        rows = await sql.unsafe(
          "SELECT id, conversation_id, sender_id, body, created_at FROM (SELECT id, conversation_id, sender_id, body, created_at FROM messages WHERE conversation_id = $1 AND (created_at, id) < ($3, $4) ORDER BY created_at DESC, id DESC LIMIT $2) AS older_messages ORDER BY created_at ASC, id ASC",
          [conversationId, limit, cursors[0].created_at, cursors[0].id],
        );
      }
      return rows.map((row) => mapMessage(row));
    },
    async getConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return findConversationForMember(sql, { conversationId, actorId });
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
                   AND (membership.last_read_at IS NULL OR unread.created_at > membership.last_read_at)) AS unread_count
         FROM conversation_participants AS membership
         JOIN conversations AS c ON c.id = membership.conversation_id
         LEFT JOIN LATERAL (
           SELECT m.id, m.conversation_id, m.sender_id, m.body, m.created_at
           FROM messages AS m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.id DESC
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
          "INSERT INTO messages (id, conversation_id, sender_id, body, idempotency_key, request_hash) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (sender_id, idempotency_key) DO NOTHING RETURNING id, conversation_id, sender_id, body, request_hash, created_at",
          [randomUUID(), conversationId, senderId, body, idempotencyKey, hash],
        );
        if (inserted.length === 0) {
          const raced = await findMessage(tx, senderId, idempotencyKey);
          if (!raced) throw new Error("Idempotency conflict row disappeared during transaction.");
          return assertSameRequest(raced, hash);
        }
        const message = inserted[0];
        const outboxId = randomUUID();
        await tx.unsafe(
          "INSERT INTO outbox_events (id, event_key, event_type, aggregate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
          [outboxId, `message:${message.id}`, "message.created", message.id,
            { messageId: message.id, conversationId: message.conversation_id, senderId: message.sender_id }],
        );
        const outboxRows = await tx.unsafe("SELECT * FROM outbox_events WHERE id = $1", [outboxId]);
        await captureChanges(tx, transactionId, [
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
  });
}
