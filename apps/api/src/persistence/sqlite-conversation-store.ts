import { createHash, randomUUID } from "node:crypto";
import {
  IdempotencyConflictError, ConversationAccessError, ConversationInputError,
  ConversationNotFoundError, InvalidMessageCursorError,
} from "../domain/errors.ts";
import { isUuid, requiredText } from "../domain/validation.ts";
import { normalizeParticipantIds } from "../domain/conversation.ts";

const iso = (value) => value == null ? null : new Date(value).toISOString();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function mapMessage(row, duplicate = false) {
  return { id: row.id, conversationId: row.conversation_id, senderId: row.sender_id, body: row.body, createdAt: iso(row.created_at), duplicate };
}
function mapConversation(row) {
  return {
    id: row.id, createdBy: row.created_by ?? null,
    participantIds: JSON.parse(row.participant_ids ?? "[]"),
    createdAt: iso(row.created_at), lastActivityAt: iso(row.last_activity_at ?? row.created_at),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessage: row.latest_message_id ? mapMessage({
      id: row.latest_message_id, conversation_id: row.latest_message_conversation_id,
      sender_id: row.latest_message_sender_id, body: row.latest_message_body,
      created_at: row.latest_message_created_at,
    }) : null,
  };
}

/** SQLite conversation/message persistence slice; intentionally not a runtime provider. */
export function createSqliteConversationStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A node:sqlite DatabaseSync connection is required.");
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; }
    catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
  }
  function activeMember(conversationId, userId) {
    return Boolean(get("SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, userId));
  }
  function requireMember(conversationId, actorId) {
    if (!activeMember(conversationId, actorId)) throw new ConversationAccessError();
  }
  function findMessage(senderId, key) {
    return get("SELECT id, conversation_id, sender_id, body, request_hash, created_at FROM messages WHERE sender_id = ? AND idempotency_key = ?", senderId, key);
  }
  function sameRequest(row, requestHash) {
    if (row.request_hash !== requestHash) throw new IdempotencyConflictError("The idempotency key was already used for a different message request.");
    return mapMessage(row, true);
  }
  return Object.freeze({
    async createConversation({ actorId, participantIds }) {
      requiredText("actorId", actorId, 300);
      const supplied = normalizeParticipantIds("participantIds", participantIds, 20);
      const others = supplied.filter((id) => id !== actorId);
      if (!others.length) throw new ConversationInputError("A conversation requires at least one other participant.");
      const ids = [actorId, ...others], id = randomUUID();
      return transaction(() => {
        run("INSERT INTO conversations (id, created_by) VALUES (?, ?)", id, actorId);
        const insert = db.prepare("INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
        for (const userId of ids) insert.run(id, userId);
        const row = get("SELECT id, created_by, created_at FROM conversations WHERE id = ?", id);
        return { id: row.id, createdBy: row.created_by, participantIds: ids, createdAt: iso(row.created_at), lastActivityAt: iso(row.created_at), unreadCount: 0, lastMessage: null };
      });
    },
    async updateConversationParticipants({ conversationId, actorId, addUserIds = [], removeUserIds = [] }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      const adds = normalizeParticipantIds("addUserIds", addUserIds, 20);
      const removes = normalizeParticipantIds("removeUserIds", removeUserIds, 20);
      if (removes.includes(actorId)) throw new ConversationInputError("The current user cannot remove themself; delete the conversation instead.");
      if (adds.some((id) => removes.includes(id))) throw new ConversationInputError("A user cannot be added and removed in the same operation.");
      return transaction(() => {
        const conversation = get("SELECT created_by FROM conversations WHERE id = ?", conversationId);
        if (!conversation) throw new ConversationNotFoundError();
        requireMember(conversationId, actorId);
        if (conversation.created_by !== actorId) throw new ConversationAccessError("Only the conversation creator can manage participants.");
        if (removes.includes(conversation.created_by)) throw new ConversationInputError("The conversation creator cannot be removed from its own conversation.");
        for (const userId of adds) {
          run(`INSERT INTO conversation_participants (conversation_id,user_id,last_read_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            ON CONFLICT(conversation_id,user_id) DO UPDATE SET
            left_at=NULL,
            joined_at=CASE WHEN conversation_participants.left_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE conversation_participants.joined_at END,
            last_read_at=CASE WHEN conversation_participants.left_at IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE conversation_participants.last_read_at END`, conversationId, userId);
        }
        for (const userId of removes) run("UPDATE conversation_participants SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, userId);
        return all("SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND left_at IS NULL ORDER BY user_id", conversationId).map((row) => row.user_id);
      });
    },
    async deleteConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      return transaction(() => {
        const conversation = get("SELECT created_by FROM conversations WHERE id = ?", conversationId);
        if (!conversation) return false;
        if (conversation.created_by !== actorId) throw new ConversationAccessError("Only the conversation creator can delete this conversation.");
        requireMember(conversationId, actorId);
        run("DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM messages WHERE conversation_id = ?)", conversationId);
        run("DELETE FROM notifications WHERE json_extract(payload, '$.conversationId') = ? AND json_extract(payload, '$.type') = 'message.created'", conversationId);
        run("DELETE FROM conversations WHERE id = ?", conversationId);
        return true;
      });
    },
    async markConversationAsRead({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      const result = run("UPDATE conversation_participants SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", conversationId, actorId);
      if (!result.changes) throw new ConversationAccessError();
      return true;
    },
    async listConversationMessages({ conversationId, actorId, limit = 100, before = null }) {
      requiredText("conversationId", conversationId, 300); requiredText("actorId", actorId, 300);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      if (before !== null && !isUuid(before)) throw new InvalidMessageCursorError("The message cursor must be a valid message ID.");
      requireMember(conversationId, actorId);
      if (before === null) {
        return all("SELECT * FROM (SELECT id,conversation_id,sender_id,body,created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC,id DESC LIMIT ?) recent ORDER BY created_at,id", conversationId, limit).map((row) => mapMessage(row));
      }
      const cursor = get("SELECT id,created_at FROM messages WHERE id = ? AND conversation_id = ?", before, conversationId);
      if (!cursor) throw new InvalidMessageCursorError();
      return all("SELECT * FROM (SELECT id,conversation_id,sender_id,body,created_at FROM messages WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT ?) older ORDER BY created_at,id", conversationId, cursor.created_at, cursor.created_at, cursor.id, limit).map((row) => mapMessage(row));
    },
    async getConversation({ conversationId, actorId }) {
      requiredText("conversationId", conversationId, 300);
      requiredText("actorId", actorId, 300);
      const row = get(`SELECT c.id,c.created_by,c.created_at,
        COALESCE(latest.created_at,c.created_at) AS last_activity_at,
        (SELECT json_group_array(user_id) FROM (SELECT user_id FROM conversation_participants cp WHERE cp.conversation_id=c.id AND cp.left_at IS NULL ORDER BY user_id)) AS participant_ids,
        latest.id AS latest_message_id,latest.conversation_id AS latest_message_conversation_id,
        latest.sender_id AS latest_message_sender_id,latest.body AS latest_message_body,latest.created_at AS latest_message_created_at,
        (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id <> ? AND (membership.last_read_at IS NULL OR m.created_at > membership.last_read_at)) AS unread_count
        FROM conversation_participants membership JOIN conversations c ON c.id=membership.conversation_id
        LEFT JOIN messages latest ON latest.id=(SELECT id FROM messages m2 WHERE m2.conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)
        WHERE membership.user_id=? AND membership.conversation_id=? AND membership.left_at IS NULL
        LIMIT 1`, actorId, actorId, conversationId);
      return row ? mapConversation(row) : null;
    },
    async listConversations({ actorId, limit = 50 }) {
      requiredText("actorId", actorId, 300);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
      return all(`SELECT c.id,c.created_by,c.created_at,
        COALESCE(latest.created_at,c.created_at) AS last_activity_at,
        (SELECT json_group_array(user_id) FROM (SELECT user_id FROM conversation_participants cp WHERE cp.conversation_id=c.id AND cp.left_at IS NULL ORDER BY user_id)) AS participant_ids,
        latest.id AS latest_message_id,latest.conversation_id AS latest_message_conversation_id,
        latest.sender_id AS latest_message_sender_id,latest.body AS latest_message_body,latest.created_at AS latest_message_created_at,
        (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id <> ? AND (membership.last_read_at IS NULL OR m.created_at > membership.last_read_at)) AS unread_count
        FROM conversation_participants membership JOIN conversations c ON c.id=membership.conversation_id
        LEFT JOIN messages latest ON latest.id=(SELECT id FROM messages m2 WHERE m2.conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)
        WHERE membership.user_id=? AND membership.left_at IS NULL
        ORDER BY COALESCE(latest.created_at,c.created_at) DESC,c.id DESC LIMIT ?`, actorId, actorId, limit).map(mapConversation);
    },
    async persistMessage({ conversationId, senderId, body, idempotencyKey }) {
      for (const [name, value] of Object.entries({ conversationId, senderId, body, idempotencyKey })) requiredText(name, value, name === "body" ? 20000 : 300);
      const requestHash = hash({ conversationId, senderId, body });
      return transaction(() => {
        requireMember(conversationId, senderId);
        const existing = findMessage(senderId, idempotencyKey);
        if (existing) return sameRequest(existing, requestHash);
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        run("INSERT INTO messages (id,conversation_id,sender_id,body,idempotency_key,request_hash,created_at) VALUES (?,?,?,?,?,?,?)", id, conversationId, senderId, body, idempotencyKey, requestHash, createdAt);
        run("INSERT INTO outbox_events (id,event_key,event_type,aggregate_id,payload) VALUES (?,?,?,?,?)", randomUUID(), `message:${id}`, "message.created", id, JSON.stringify({ messageId:id, conversationId, senderId }));
        return mapMessage(get("SELECT id,conversation_id,sender_id,body,created_at FROM messages WHERE id = ?", id));
      });
    },
    async listConversationParticipantIds({ conversationId }) {
      requiredText("conversationId", conversationId, 300);
      return all("SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND left_at IS NULL ORDER BY user_id", conversationId).map((row) => row.user_id);
    },
  });
}
