/**
 * Dispatch up to `limit` transactional outbox events.
 * Delivery is at-least-once: consumers must deduplicate by eventKey.
 */
function safeErrorName(error) {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

export async function dispatchOutboxBatch({
  store,
  deliver,
  limit = 25,
  leaseSeconds = 60,
  retryDelaySeconds = 30,
  onDeliveryFailure = null,
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
    } catch (error) {
      // A stale worker's lease may have expired or been superseded. Never
      // postpone another worker's lease, and record whether a retry was queued.
      let retryScheduled = false;
      let retryScheduleError = null;
      try {
        retryScheduled = Boolean(await store.rescheduleOutboxEvent({
          eventId: event.id,
          leaseToken: event.lease_token,
          delaySeconds: retryDelaySeconds,
        }));
      } catch (scheduleError) {
        retryScheduleError = scheduleError;
      }

      // Observability must never change the delivery/retry result. Only expose
      // identifiers, attempt counts and error classes—not payloads or messages.
      if (typeof onDeliveryFailure === "function") {
        try {
          onDeliveryFailure({
            eventId: event.id,
            eventType: event.event_type,
            attempts: event.attempts,
            errorName: safeErrorName(error),
            retryScheduled,
            retryScheduleErrorName: retryScheduleError ? safeErrorName(retryScheduleError) : null,
          });
        } catch {
          // Ignore logger/observer failures; delivery state remains authoritative.
        }
      }
      if (retryScheduleError) throw retryScheduleError;
      failed += 1;
    }
  }
  return { claimed, delivered, failed };
}
