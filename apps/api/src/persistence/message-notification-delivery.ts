/**
 * Converts durable message.created outbox events into per-recipient inbox rows.
 * The event key is reused per recipient, making delivery safe to retry after partial failure.
 */
export function createMessageNotificationDelivery({ store }) {
  if (!store || typeof store.listConversationParticipantIds !== "function" || typeof store.createNotification !== "function") {
    throw new TypeError("A store with conversation participant and notification operations is required.");
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
        typeof payload.messageId !== "string" || typeof payload.conversationId !== "string" ||
        typeof payload.senderId !== "string") {
      throw new TypeError("message.created event payload is malformed.");
    }
    const participantIds = await store.listConversationParticipantIds({ conversationId: payload.conversationId });
    if (!participantIds.includes(payload.senderId)) {
      throw new Error("The message sender is not a current conversation participant.");
    }
    for (const userId of participantIds) {
      if (userId === payload.senderId) continue;
      await store.createNotification({
        userId,
        eventKey: event.event_key,
        payload: {
          type: "message.created",
          messageId: payload.messageId,
          conversationId: payload.conversationId,
          senderId: payload.senderId,
        },
      });
    }
  };
}
