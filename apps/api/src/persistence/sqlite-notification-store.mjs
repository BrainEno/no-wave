import { createHash, randomUUID } from "node:crypto";
import { InvalidMessageCursorError, IdempotencyConflictError } from "../domain/errors.mjs";
import { isUuid } from "../domain/validation.mjs";

/**
 * SQLite persistence slice for notifications. This remains an opt-in adapter
 * component until every persistence port has contract parity.
 */
function requiredText(name, value) {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${name} must be a non-empty, trimmed string.`);
  }
}
function requestHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function parsePayload(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function mapNotification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    eventKey: row.event_key,
    payload: parsePayload(row.payload),
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at == null ? null : new Date(row.read_at).toISOString(),
  };
}

export function createSqliteNotificationStore(db) {
  if (!db || typeof db.prepare !== "function" || typeof db.exec !== "function") {
    throw new TypeError("A SQLite database connection is required.");
  }
  const list = db.prepare(
    "SELECT id, user_id, event_key, payload, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
  );
  const unread = db.prepare("SELECT count(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL");
  const markAll = db.prepare(
    "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND read_at IS NULL",
  );
  const markOne = db.prepare(
    "UPDATE notifications SET read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ? AND user_id = ?",
  );
  const getOne = db.prepare(
    "SELECT id, user_id, event_key, payload, created_at, read_at FROM notifications WHERE id = ? AND user_id = ?",
  );
  const insert = db.prepare(
    "INSERT INTO notifications (id, user_id, event_key, payload, payload_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, event_key) DO NOTHING",
  );
  const getByKey = db.prepare(
    "SELECT id, user_id, event_key, payload, created_at, payload_hash FROM notifications WHERE user_id = ? AND event_key = ?",
  );

  return Object.freeze({
    async listNotifications({ actorId, limit = 50 }) {
      requiredText("actorId", actorId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer between 1 and 100.");
      }
      return list.all(actorId, limit).map(mapNotification);
    },
    async getUnreadNotificationCount({ actorId }) {
      requiredText("actorId", actorId);
      return Number(unread.get(actorId).count);
    },
    async markAllNotificationsRead({ actorId }) {
      requiredText("actorId", actorId);
      return Number(markAll.run(actorId).changes);
    },
    async markNotificationRead({ notificationId, actorId }) {
      requiredText("actorId", actorId);
      if (!isUuid(notificationId)) {
        throw new InvalidMessageCursorError("notificationId must be a valid notification ID.");
      }
      markOne.run(notificationId, actorId);
      const row = getOne.get(notificationId, actorId);
      return row ? mapNotification(row) : null;
    },
    async createNotification({ userId, eventKey, payload }) {
      requiredText("userId", userId);
      requiredText("eventKey", eventKey);
      if (payload === undefined) throw new TypeError("payload is required.");
      const hash = requestHash(payload);
      db.exec("BEGIN IMMEDIATE");
      try {
        insert.run(randomUUID(), userId, eventKey, JSON.stringify(payload), hash);
        const row = getByKey.get(userId, eventKey);
        if (!row) throw new Error("Notification idempotency row disappeared during transaction.");
        if (row.payload_hash !== hash) {
          throw new IdempotencyConflictError("The notification event key was already used with a different payload.");
        }
        const duplicate = Number(insert.changes ?? 0) === 0;
        db.exec("COMMIT");
        return {
          id: row.id,
          userId: row.user_id,
          eventKey: row.event_key,
          payload: parsePayload(row.payload),
          createdAt: new Date(row.created_at).toISOString(),
          duplicate,
        };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
        throw error;
      }
    },
  });
}
