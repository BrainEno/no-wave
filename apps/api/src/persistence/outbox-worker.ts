/** Dispatch at most `limit` leased events; consumers still deduplicate at-least-once delivery. */
import type { OutboxPersistencePort, StoredOutboxEvent } from "../application/persistence-ports.ts";
import { outboxRetryDelaySeconds, resolveOutboxRetryPolicy } from "./outbox-retry-policy.ts";

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

/** Only identifiers, counts and classes; never payloads or exception messages. */
export type OutboxDeliveryFailure = {
  eventId: string;
  eventType: string;
  attempts: number;
  errorName: string;
  retryScheduled: boolean;
  deadLettered: boolean;
  retryDelaySeconds: number | null;
  retryScheduleErrorName: string | null;
};
export type DispatchOutboxBatchInput = {
  store: Pick<OutboxPersistencePort, "claimOutboxEvents" | "markOutboxDelivered" | "rescheduleOutboxEvent">;
  deliver: (event: StoredOutboxEvent) => Promise<void>;
  limit?: number;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
  maxRetryDelaySeconds?: number;
  maxAttempts?: number;
  onDeliveryFailure?: ((failure: OutboxDeliveryFailure) => void) | null;
};

export async function dispatchOutboxBatch({
  store, deliver, limit = 25, leaseSeconds = 60,
  retryDelaySeconds, maxRetryDelaySeconds, maxAttempts, onDeliveryFailure = null,
}: DispatchOutboxBatchInput) {
  if (!store || typeof store.claimOutboxEvents !== "function" ||
      typeof store.markOutboxDelivered !== "function" || typeof store.rescheduleOutboxEvent !== "function") {
    throw new TypeError("A store with outbox operations is required.");
  }
  if (typeof deliver !== "function") throw new TypeError("An event delivery function is required.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be an integer between 1 and 100.");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) throw new TypeError("leaseSeconds must be an integer between 1 and 3600.");
  const policy = resolveOutboxRetryPolicy({ retryDelaySeconds, maxRetryDelaySeconds, maxAttempts });
  let claimed = 0, delivered = 0, failed = 0, deadLettered = 0;
  while (claimed < limit) {
    // Claim just before delivery so later events do not expire waiting in a batch.
    const [event] = await store.claimOutboxEvents({ limit: 1, leaseSeconds, maxAttempts: policy.maxAttempts });
    if (!event) break;
    claimed += 1;
    try {
      await deliver(event);
      const marked = await store.markOutboxDelivered({ eventId: event.id, leaseToken: event.lease_token });
      if (!marked) throw new Error("Outbox event was already delivered or its lease was lost.");
      delivered += 1;
    } catch (error) {
      const nextDelay = outboxRetryDelaySeconds(event.attempts, policy);
      let retryScheduled = false, terminal = false;
      let retryScheduleError: unknown = null;
      try {
        // The database checks both lease ownership and its own attempt count.
        // A false result is a lost lease, not a successful retry or dead letter.
        const settled = Boolean(await store.rescheduleOutboxEvent({
          eventId: event.id, leaseToken: event.lease_token,
          delaySeconds: nextDelay ?? policy.retryDelaySeconds, maxAttempts: policy.maxAttempts,
        }));
        retryScheduled = settled && nextDelay !== null;
        terminal = settled && nextDelay === null;
      } catch (scheduleError) {
        retryScheduleError = scheduleError;
      }
      if (typeof onDeliveryFailure === "function") {
        try {
          onDeliveryFailure({
            eventId: event.id, eventType: event.event_type, attempts: event.attempts,
            errorName: safeErrorName(error), retryScheduled, deadLettered: terminal,
            retryDelaySeconds: retryScheduled ? nextDelay : null,
            retryScheduleErrorName: retryScheduleError ? safeErrorName(retryScheduleError) : null,
          });
        } catch {
          // Observers cannot alter authoritative persistence state.
        }
      }
      if (retryScheduleError) throw retryScheduleError;
      failed += 1;
      if (terminal) deadLettered += 1;
    }
  }
  return { claimed, delivered, failed, deadLettered };
}
