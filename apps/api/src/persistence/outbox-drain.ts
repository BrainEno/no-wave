import { dispatchOutboxBatch } from "./outbox-worker.ts";

/**
 * One bounded drain of the transactional outbox.
 *
 * The long-lived worker (`notification-worker.ts`) is right when a process can
 * stay alive. On the qualified zero-cost host it cannot: there is no free worker
 * or cron instance, so delivery has to be driven by something that *can* run on
 * a schedule — and the only cardless options are external schedulers that either
 * call an HTTP endpoint or start a short-lived process.
 *
 * This module is the shared core for both, and it is deliberately a *bounded*
 * drain rather than "deliver everything":
 *
 *   - a wall-clock `deadlineMs` keeps one invocation from overrunning a
 *     0.1-CPU instance or a scheduler's timeout;
 *   - `maxBatches` caps the work even when the clock is generous;
 *   - a batch-level failure stops the drain and is reported, so the scheduler
 *     retries on the next tick instead of looping over a broken connection.
 *
 * Delivery semantics are unchanged: `dispatchOutboxBatch` claims one event at a
 * time under a lease, marks it delivered by lease token, and reschedules on
 * failure. Two drains running at once — or a drain and the worker — therefore
 * deliver each event at least once and never fight over an event they both
 * claimed; consumers still deduplicate by `eventKey`.
 */

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

export type OutboxDrainStopReason = "empty" | "deadline" | "batch-limit" | "batch-failed";

export type OutboxDrainResult = {
  batches: number;
  claimed: number;
  delivered: number;
  failed: number;
  stopReason: OutboxDrainStopReason;
  durationMs: number;
  /** Error class of a batch-level failure, if the drain stopped because of one. */
  errorName: string | null;
};

export type OutboxDrainOptions = {
  store: Parameters<typeof dispatchOutboxBatch>[0]["store"];
  deliver: Parameters<typeof dispatchOutboxBatch>[0]["deliver"];
  batchLimit?: number;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
  /** Wall-clock budget for the whole invocation. */
  deadlineMs?: number;
  /** Maximum number of batches, independent of the clock. */
  maxBatches?: number;
  now?: () => number;
  onDeliveryFailure?: Parameters<typeof dispatchOutboxBatch>[0]["onDeliveryFailure"];
};

function integerSetting(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export async function runOutboxDrain(options: OutboxDrainOptions): Promise<OutboxDrainResult> {
  const batchLimit = integerSetting("batchLimit", options.batchLimit ?? 25, 1, 100);
  const leaseSeconds = integerSetting("leaseSeconds", options.leaseSeconds ?? 60, 1, 3600);
  const retryDelaySeconds = integerSetting("retryDelaySeconds", options.retryDelaySeconds ?? 30, 1, 86400);
  const deadlineMs = integerSetting("deadlineMs", options.deadlineMs ?? 10_000, 1, 600_000);
  const maxBatches = integerSetting("maxBatches", options.maxBatches ?? 20, 1, 1000);
  const now = options.now ?? Date.now;

  const startedAt = now();
  let batches = 0;
  let claimed = 0;
  let delivered = 0;
  let failed = 0;
  let stopReason: OutboxDrainStopReason = "empty";
  let errorName: string | null = null;

  while (true) {
    if (batches >= maxBatches) {
      stopReason = "batch-limit";
      break;
    }
    if (now() - startedAt >= deadlineMs) {
      stopReason = "deadline";
      break;
    }

    try {
      const result = await dispatchOutboxBatch({
        store: options.store,
        deliver: options.deliver,
        limit: batchLimit,
        leaseSeconds,
        retryDelaySeconds,
        onDeliveryFailure: options.onDeliveryFailure,
      });
      batches += 1;
      claimed += result.claimed;
      delivered += result.delivered;
      failed += result.failed;
      if (result.claimed === 0) {
        stopReason = "empty";
        break;
      }
    } catch (error: unknown) {
      // Report, do not swallow: the caller decides whether a failed drain is a
      // non-zero exit (scheduler) or a logged retry (worker).
      errorName = safeErrorName(error);
      stopReason = "batch-failed";
      break;
    }
  }

  return { batches, claimed, delivered, failed, stopReason, errorName, durationMs: now() - startedAt };
}
