import { isUuid } from "../domain/validation.ts";

/**
 * Convert a durable message.created event into inbox rows. The adapter must
 * select the current membership and write all recipients in one transaction,
 * serialized with membership changes and conversation deletion.
 */
export function createMessageNotificationDelivery({ store }) {
  if (!store || typeof store.deliverMessageNotifications !== "function") {
    throw new TypeError("A store with atomic message notification delivery is required.");
  }
  return async function deliverMessageNotification(event) {
    if (!event || event.event_type !== "message.created" || typeof event.event_key !== "string") {
      throw new TypeError("Unsupported or malformed outbox event.");
    }
    let payload = event.payload;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch {
        throw new TypeError("message.created event payload is malformed JSON.");
      }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !isUuid(payload.messageId) || typeof payload.conversationId !== "string" ||
        payload.conversationId.length === 0 || payload.conversationId.trim() !== payload.conversationId ||
        typeof payload.senderId !== "string" || payload.senderId.length === 0 || payload.senderId.trim() !== payload.senderId ||
        event.event_key.length === 0 || event.event_key.trim() !== event.event_key ||
        (event.aggregate_id !== undefined && event.aggregate_id !== payload.messageId)) {
      throw new TypeError("message.created event payload is malformed.");
    }
    await store.deliverMessageNotifications({
      eventKey: event.event_key,
      messageId: payload.messageId,
      conversationId: payload.conversationId,
      senderId: payload.senderId,
    });
  };
}
