/**
 * Dispatch up to `limit` transactional outbox events.
 * Delivery is at-least-once: consumers must deduplicate by eventKey.
 */
export async function dispatchOutboxBatch({
  store,
  deliver,
  limit = 25,
  leaseSeconds = 60,
  retryDelaySeconds = 30,
}) {
  if (!store || typeof store.claimOutboxEvents !== "function" ||
      typeof store.markOutboxDelivered !== "function" ||
      typeof store.rescheduleOutboxEvent !== "function") {
    throw new TypeError("A store with outbox operations is required.");
  }
  if (typeof deliver !== "function") throw new TypeError("An event delivery function is required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
  if (!Number.isInteger(retryDelaySeconds) || retryDelaySeconds < 1 || retryDelaySeconds > 86400) throw new TypeError("retryDelaySeconds must be an integer between 1 and 86400.");

  let claimed = 0;
  let delivered = 0;
  let failed = 0;
  while (claimed < limit) {
    // Claim immediately before delivery. Leasing an entire batch up front can
    // let later events expire while they wait behind a slow first delivery.
    const [event] = await store.claimOutboxEvents({ limit: 1, leaseSeconds });
    if (!event) break;
    claimed += 1;
    try {
      await deliver(event);
      const marked = await store.markOutboxDelivered({ eventId: event.id, leaseToken: event.lease_token });
      if (!marked) throw new Error("Outbox event was already delivered or its lease was lost.");
      delivered += 1;
    } catch {
      // Returns false after expiry, deletion or a newer claim; never postpone
      // another worker's lease. A database failure itself still propagates.
      await store.rescheduleOutboxEvent({ eventId: event.id, leaseToken: event.lease_token, delaySeconds: retryDelaySeconds });
      failed += 1;
    }
  }
  return { claimed, delivered, failed };
}
