import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { runOutboxDrain } from "./outbox-drain.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";

/**
 * One-shot notification outbox drain.
 *
 *     pnpm --filter @bot-thk/api drain:notifications
 *
 * This is the cardless hosted delivery path: an external scheduler (a scheduled
 * GitHub Action, cron-job.org, or any cron on a machine that can reach the
 * database) starts this process, it drains what is due and exits. There is no
 * long-lived worker to pay for and no public HTTP endpoint to protect, so no
 * drain secret has to exist in the Web app's environment.
 *
 * Safety comes from the outbox, not from the process being unique: events are
 * claimed under a lease and marked delivered by lease token, so an overlapping
 * drain (or a slow previous invocation, or the long-lived worker) cannot
 * double-deliver an event it no longer owns. Consumers still deduplicate by
 * `eventKey`, because delivery remains at-least-once.
 *
 * Every setting is validated and bounded before the pool is opened, and the
 * invocation is bounded again by a wall-clock deadline and a batch cap, so a
 * 0.1-CPU instance cannot be pinned by a backlog.
 */

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const batchLimit = integerSetting("OUTBOX_BATCH_LIMIT", 25, 1, 100);
const leaseSeconds = integerSetting("OUTBOX_LEASE_SECONDS", 60, 1, 3600);
const retryDelaySeconds = integerSetting("OUTBOX_RETRY_DELAY_SECONDS", 30, 1, 86400);
const deadlineMs = integerSetting("OUTBOX_DRAIN_DEADLINE_MS", 10_000, 1, 600_000);
const maxBatches = integerSetting("OUTBOX_DRAIN_MAX_BATCHES", 20, 1, 1000);

function writeDrainLog(level, event, fields = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: "notification-drain",
    event,
    ...fields,
  }) + "\n";
  if (level === "warn" || level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

async function runDrain() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the notification drain.");
  const sql = await createPostgresClient({ connectionString: process.env.DATABASE_URL });
  try {
    const store = createPostgresStore(sql);
    await store.health();
    const deliver = createMessageNotificationDelivery({ store });

    writeDrainLog("info", "outbox_drain_started", {
      batchLimit, leaseSeconds, retryDelaySeconds, deadlineMs, maxBatches,
    });
    const result = await runOutboxDrain({
      store,
      deliver,
      batchLimit,
      leaseSeconds,
      retryDelaySeconds,
      deadlineMs,
      maxBatches,
      onDeliveryFailure: (failure) => writeDrainLog(
        failure.retryScheduled && !failure.retryScheduleErrorName ? "warn" : "error",
        "outbox_event_failed",
        failure,
      ),
    });

    if (result.errorName) {
      writeDrainLog("error", "outbox_drain_failed", result);
    } else {
      writeDrainLog(result.failed > 0 ? "warn" : "info", "outbox_drain_completed", result);
    }
    return result.errorName === null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

runDrain().then(
  (ok) => {
    process.exitCode = ok ? 0 : 1;
  },
  (error) => {
    // Driver messages can contain connection strings and SQL details: log the
    // class only, and exit non-zero so the scheduler records the failure.
    writeDrainLog("error", "outbox_drain_failed_to_start", {
      errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error",
    });
    process.exitCode = 1;
  },
);
