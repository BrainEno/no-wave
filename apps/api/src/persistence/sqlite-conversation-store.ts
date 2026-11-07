import { createHash, randomUUID } from "node:crypto";
import { createMigrationTransactionId } from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationCapture, migrationEntityKey, type CapturedChange } from "./sqlite-provider-migration-capture.ts";
import {
  IdempotencyConflictError, ConversationAccessError, ConversationInputError,
  ConversationNotFoundError, InvalidMessageCursorError,
} from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { normalizeParticipantIds } from "../domain/conversation.ts";
import type { TypedPersistenceAdapterContract } from "../application/persistence-ports.ts";
import { isoDate } from "./sqlite.ts";
import type { SqliteRow, SqliteRunner } from "./sqlite.ts";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type MappedMessage = { id: string; conversationId: string; senderId: string; body: string; createdAt: string; duplicate: boolean };
type MappedConversation = {
  id: string;
  createdBy: string | null;
  participantIds: string[];
  createdAt: string;
  lastActivityAt: string;
  unreadCount: number;
  lastMessage: MappedMessage | null;
};
function mapMessage(row: SqliteRow, duplicate = false): MappedMessage {
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, body: row.body, createdAt: isoDate(row.created_at), duplicate };
}
function mapConversation(row: SqliteRow): MappedConversation {
  return {
    id: row.id, createdBy: row.created_by ?? null,
    participantIds: JSON.parse(row.participant_ids ?? "[]") as string[],
    createdAt: isoDate(row.created_at), lastActivityAt: isoDate(row.last_activity_at ?? row.created_at),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessage: row.latest_message_id ? mapMessage({
      id: row.latest_message_id, conversation_id: row.latest_message_conversation_id,
      sender_id: row.latest_message_sender_id, body: row.latest_message_body,
      created_at: row.latest_message_created_at,
    }) : null,
  };
}

/** SQLite conversation/message persistence slice, composed by sqlite-store.ts. */
export function createSqliteConversationStore(db: SqliteRunner) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const migrationCapture = createSqliteProviderMigrationCapture(db);
  const get = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args);
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);

  /** The row a capture just wrote; a missing one is a bug, not a valid payload. */
  function one(sql: string, ...args: unknown[]): SqliteRow {
    const row = get(sql, ...args);
    if (!row) throw new Error("Expected a row for the migration capture: " + sql);
    return row;
  }

  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  function transaction<T>(work: (transactionId: string) => T): T {
    const transactionId = createMigrationTransactionId();
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(transactionId); db.exec("COMMIT"); return value; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  function activeMember(conversationId: string, userId: string): boolean {
    return Boolean(get("SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, userId));
  }
  function requireMember(conversationId: string, actorId: string): void {
    if (!activeMember(conversationId, actorId)) throw new ConversationAccessError();
  }
  function findMessage(senderId: string, key: string) {
    return get("SELECT id, conversation_id, sender_id, body, request_hash, created_at FROM messages WHERE sender_id = ? AND idempotency_key = ?", senderId, key);
  }
  function sameRequest(row: SqliteRow, requestHash: string): MappedMessage {
    if (row.request_hash !== requestHash) throw new IdempotencyConflictError("The idempotency key was already used for a different message request.");
    return mapMessage(row, true);
  }
  /**
   * The conversation as one of its active members sees it.
   *
   * Shared by the read endpoint and by the replay path of `createConversation`:
   * a replayed create returns what the conversation *is now* (participants may
   * have been added since), not a frozen copy of the 201 it would have returned.
   */
  function conversationForMember(conversationId: string, memberId: string): MappedConversation | null {
    const row = get(`SELECT c.id,c.created_by,c.created_at,
        COALESCE(latest.created_at,c.created_at) AS last_activity_at,
        (SELECT json_group_array(user_id) FROM (SELECT user_id FROM conversation_participants cp WHERE cp.conversation_id=c.id AND cp.left_at IS NULL ORDER BY user_id)) AS participant_ids,
        latest.id AS latest_message_id,latest.conversation_id AS latest_message_conversation_id,
        latest.sender_id AS latest_message_sender_id,latest.body AS latest_message_body,latest.created_at AS latest_message_created_at,
        (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id <> ? AND m.conversation_sequence > membership.last_read_sequence) AS unread_count
        FROM conversation_participants membership JOIN conversations c ON c.id=membership.conversation_id
        LEFT JOIN messages latest ON latest.id=(SELECT id FROM messages m2 WHERE m2.conversation_id=c.id ORDER BY conversation_sequence DESC LIMIT 1)
        WHERE membership.user_id=? AND membership.conversation_id=? AND membership.left_at IS NULL
        LIMIT 1`, memberId, memberId, conversationId);
    return row ? mapConversation(row) : null;
  }
  return Object.freeze({
    async createConversation({ actorId, participantIds, idempotencyKey = null }) {
      requiredText("actorId", actorId, 300);
      const supplied = normalizeParticipantIds("participantIds", participantIds, 20);
      const others = supplied.filter((id) => id !== actorId);
      if (!others.length) throw new ConversationInputError("A conversation requires at least one other participant.");
      if (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 ||
          idempotencyKey.length > 300 || idempotencyKey.trim() !== idempotencyKey)) {
        throw new ConversationInputError("Idempotency-Key must be a non-empty trimmed string no longer than 300 characters.");
      }
      const ids = [actorId, ...others], id = randomUUID();
      const keyHash = idempotencyKey === null ? null : hash({ method: "POST", route: "/api/v1/conversations", actorId, key: idempotencyKey });
      const fingerprint = hash({ actorId, participantIds: [...ids].sort() });
      return transaction((transactionId) => {
        if (keyHash !== null) {
          const existing = get("SELECT id, request_hash FROM conversations WHERE created_by = ? AND idempotency_key_hash = ?", actorId, keyHash);
          if (existing) {
            if (existing.request_hash !== fingerprint) {
              throw new IdempotencyConflictError("The idempotency key was already used for a different conversation request.");
            }
            return conversationForMember(existing.id, actorId);
          }
        }
        run("INSERT INTO conversations (id, created_by, idempotency_key_hash, request_hash) VALUES (?, ?, ?, ?)", id, actorId, keyHash, keyHash === null ? null : fingerprint);
        const insert = db.prepare("INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
        for (const userId of ids) insert.run(id, userId);
        const row = one("SELECT * FROM conversations WHERE id = ?", id);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "conversations", entityId: id, operation: "upsert", payload: row },
          ...ids.map((userId) => ({ entityType: "conversation_participants", entityId: migrationEntityKey(id, userId), operation: "upsert" as const, payload: one("SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?", id, userId) })),
        ]);
        return { id: String(row.id), createdBy: row.created_by ?? null, participantIds: ids, createdAt: isoDate(row.created_at), lastActivityAt: isoDate(row.created_at), unreadCount: 0, lastMessage: null };
      });
    },
    async updateConversationParticipants({ conversationId, actorId, addUserIds = [], removeUserIds = [] }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      const adds = normalizeParticipantIds("addUserIds", addUserIds, 20);
      const removes = normalizeParticipantIds("removeUserIds", removeUserIds, 20);
      if (removes.includes(actorId)) throw new ConversationInputError("The current user cannot remove themself; delete the conversation instead.");
      if (adds.some((id) => removes.includes(id))) throw new ConversationInputError("A user cannot be added and removed in the same operation.");
      return transaction((transactionId) => {
        const conversation = get("SELECT created_by FROM conversations WHERE id = ?", conversationId);
        if (!conversation) throw new ConversationNotFoundError();
        requireMember(conversationId, actorId);
        if (conversation.created_by !== actorId) throw new ConversationAccessError("Only the conversation creator can manage participants.");
        if (removes.includes(conversation.created_by)) throw new ConversationInputError("The conversation creator cannot be removed from its own conversation.");
        for (const userId of adds) {
          run(`INSERT INTO conversation_participants (conversation_id,user_id,last_read_at,last_read_sequence)
            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), (SELECT last_message_sequence FROM conversations WHERE id = ?))
            ON CONFLICT(conversation_id,user_id) DO UPDATE SET
            left_at=NULL,
            joined_at=CASE WHEN conversation_participants.left_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE conversation_participants.joined_at END,
            last_read_at=CASE WHEN conversation_participants.left_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE conversation_participants.last_read_at END,
            last_read_sequence=CASE WHEN conversation_participants.left_at IS NOT NULL THEN excluded.last_read_sequence ELSE conversation_participants.last_read_sequence END`, conversationId, userId, conversationId);
        }
        for (const userId of removes) run("UPDATE conversation_participants SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, userId);
        const changedUserIds = [...new Set([...adds, ...removes])];
        migrationCapture.captureInTransaction(db, transactionId, changedUserIds.map((userId) => ({
          entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, userId), operation: "upsert" as const,
          payload: one("SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?", conversationId, userId),
        })).filter((change) => change.payload != null));
        return all("SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND left_at IS NULL ORDER BY user_id", conversationId).map((row) => row.user_id);
      });
    },
    async deleteConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      return transaction((transactionId) => {
        const conversation = get("SELECT * FROM conversations WHERE id = ?", conversationId);
        if (!conversation) return false;
        if (conversation.created_by !== actorId) throw new ConversationAccessError("Only the conversation creator can delete this conversation.");
        requireMember(conversationId, actorId);
        const participants = all("SELECT * FROM conversation_participants WHERE conversation_id = ?", conversationId);
        const messages = all("SELECT * FROM messages WHERE conversation_id = ?", conversationId);
        const outbox = all("SELECT * FROM outbox_events WHERE aggregate_id IN (SELECT id FROM messages WHERE conversation_id = ?)", conversationId);
        const notifications = all("SELECT * FROM notifications WHERE json_extract(payload, '$.conversationId') = ? AND json_extract(payload, '$.type') = 'message.created'", conversationId);
        run("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM messages WHERE conversation_id = ?)", conversationId);
        run("DELETE FROM notifications WHERE json_extract(payload, '$.conversationId') = ? AND json_extract(payload, '$.type') = 'message.created'", conversationId);
        run("DELETE FROM conversations WHERE id = ?", conversationId);
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "conversations", entityId: conversationId, operation: "delete", payload: null },
          ...participants.map((row): CapturedChange => ({ entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, row.user_id), operation: "delete", payload: null })),
          ...messages.map((row): CapturedChange => ({ entityType: "messages", entityId: row.id, operation: "delete", payload: null })),
          ...outbox.map((row): CapturedChange => ({ entityType: "outbox_events", entityId: row.id, operation: "delete", payload: null })),
          ...notifications.map((row): CapturedChange => ({ entityType: "notifications", entityId: row.id, operation: "delete", payload: null })),
        ]);
        return true;
      });
    },
    async markConversationAsRead({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      return transaction((transactionId) => {
        const result = run(`UPDATE conversation_participants SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          last_read_sequence = (SELECT last_message_sequence FROM conversations WHERE id = ?)
          WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL`, conversationId, conversationId, actorId);
        if (!result.changes) throw new ConversationAccessError();
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "conversation_participants", entityId: migrationEntityKey(conversationId, actorId), operation: "upsert", payload: one("SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?", conversationId, actorId) },
        ]);
        return true;
      });
    },
    async listConversationMessages({ conversationId, actorId, limit = 100, before = null }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (before !== null && !isUuid(before)) throw new InvalidMessageCursorError("The message cursor must be a valid message ID.");
      requireMember(conversationId, actorId);
      if (before === null) {
        return all("SELECT * FROM (SELECT id,conversation_id,sender_id,body,created_at,conversation_sequence FROM messages WHERE conversation_id = ? ORDER BY conversation_sequence DESC LIMIT ?) recent ORDER BY conversation_sequence", conversationId, limit).map((row) => mapMessage(row));
      }
      const cursor = get("SELECT conversation_sequence FROM messages WHERE id = ? AND conversation_id = ?", before, conversationId);
      if (!cursor) throw new InvalidMessageCursorError();
      return all("SELECT * FROM (SELECT id,conversation_id,sender_id,body,created_at,conversation_sequence FROM messages WHERE conversation_id = ? AND conversation_sequence < ? ORDER BY conversation_sequence DESC LIMIT ?) older ORDER BY conversation_sequence", conversationId, cursor.conversation_sequence, limit).map((row) => mapMessage(row));
    },
    async getConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      return conversationForMember(conversationId, actorId);
    },
    async listConversations({ actorId, limit = 50 }) {
      requiredText("actorId", actorId, 300);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      return all(`SELECT c.id,c.created_by,c.created_at,
        COALESCE(latest.created_at,c.created_at) AS last_activity_at,
        (SELECT json_group_array(user_id) FROM (SELECT user_id FROM conversation_participants cp WHERE cp.conversation_id=c.id AND cp.left_at IS NULL ORDER BY user_id)) AS participant_ids,
        latest.id AS latest_message_id,latest.conversation_id AS latest_message_conversation_id,
        latest.sender_id AS latest_message_sender_id,latest.body AS latest_message_body,latest.created_at AS latest_message_created_at,
        (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id <> ? AND m.conversation_sequence > membership.last_read_sequence) AS unread_count
        FROM conversation_participants membership JOIN conversations c ON c.id=membership.conversation_id
        LEFT JOIN messages latest ON latest.id=(SELECT id FROM messages m2 WHERE m2.conversation_id=c.id ORDER BY conversation_sequence DESC LIMIT 1)
        WHERE membership.user_id=? AND membership.left_at IS NULL
        ORDER BY COALESCE(latest.created_at,c.created_at) DESC,c.id DESC LIMIT ?`, actorId, actorId, limit).map(mapConversation);
    },
    async persistMessage({ conversationId, senderId, body, idempotencyKey }) {
      for (const [name, value] of Object.entries({ conversationId, senderId, body, idempotencyKey })) requiredText(name, value, name === "body" ? 20000 : 300);
      const requestHash = hash({ conversationId, senderId, body });
      return transaction((transactionId) => {
        requireMember(conversationId, senderId);
        const existing = findMessage(senderId, idempotencyKey);
        if (existing) return sameRequest(existing, requestHash);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        // BEGIN IMMEDIATE serializes this counter, message and outbox write with
        // marks and membership changes on every SQLite connection.
        run("UPDATE conversations SET last_message_sequence = last_message_sequence + 1 WHERE id = ?", conversationId);
        run(`INSERT INTO messages (id,conversation_id,sender_id,body,idempotency_key,request_hash,created_at,conversation_sequence)
          VALUES (?,?,?,?,?,?,?,(SELECT last_message_sequence FROM conversations WHERE id = ?))`, id, conversationId, senderId, body, idempotencyKey, requestHash, createdAt, conversationId);
        const outboxId = randomUUID();
        const outboxPayload = { messageId:id, conversationId, senderId };
        run("INSERT INTO outbox_events (id,event_key,event_type,aggregate_id,payload) VALUES (?,?,?,?,?)", outboxId, `message:${id}`, "message.created", id, JSON.stringify(outboxPayload));
        migrationCapture.captureInTransaction(db, transactionId, [
          { entityType: "conversations", entityId: conversationId, operation: "upsert", payload: one("SELECT * FROM conversations WHERE id = ?", conversationId) },
          { entityType: "messages", entityId: id, operation: "upsert", payload: one("SELECT * FROM messages WHERE id = ?", id) },
          { entityType: "outbox_events", entityId: outboxId, operation: "upsert", payload: one("SELECT * FROM outbox_events WHERE id = ?", outboxId) },
        ]);
        return mapMessage(one("SELECT id,conversation_id,sender_id,body,created_at FROM messages WHERE id = ?", id));
      });
    },
    async listConversationParticipantIds({ conversationId }) {
      requiredText("conversationId", conversationId, 300);
      return all("SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND left_at IS NULL ORDER BY user_id", conversationId).map((row) => row.user_id);
    },
  }) satisfies Pick<TypedPersistenceAdapterContract, "createConversation" | "updateConversationParticipants" | "deleteConversation" | "markConversationAsRead" | "listConversationMessages" | "getConversation" | "listConversations" | "persistMessage" | "listConversationParticipantIds">;
}
