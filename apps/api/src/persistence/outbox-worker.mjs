/**
 * Dispatch a leased batch of transactional outbox events.
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
  const events = await store.claimOutboxEvents({ limit, leaseSeconds });
  let delivered = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await deliver(event);
      const marked = await store.markOutboxDelivered({ eventId: event.id });
      if (!marked) throw new Error("Outbox event was already delivered or its lease was lost.");
      delivered += 1;
    } catch {
      await store.rescheduleOutboxEvent({ eventId: event.id, delaySeconds: retryDelaySeconds });
      failed += 1;
    }
  }
  return { claimed: events.length, delivered, failed };
}
