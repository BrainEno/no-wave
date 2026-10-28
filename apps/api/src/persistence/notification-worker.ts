import { createPostgresClient, createPostgresStore } from "./postgres.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";

function integerSetting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const pollIntervalMs = integerSetting("OUTBOX_POLL_INTERVAL_MS", 1000, 100, 60000);
const batchLimit = integerSetting("OUTBOX_BATCH_LIMIT", 25, 1, 100);
const leaseSeconds = integerSetting("OUTBOX_LEASE_SECONDS", 60, 1, 3600);
const retryDelaySeconds = integerSetting("OUTBOX_RETRY_DELAY_SECONDS", 30, 1, 86400);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function safeErrorName(error) {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

function writeWorkerLog(level, event, fields = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: "notification-worker",
    event,
    ...fields,
  }) + "\n";
  if (level === "warn" || level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

async function runWorker() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the notification worker.");
  const sql = await createPostgresClient({ connectionString: process.env.DATABASE_URL });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const store = createPostgresStore(sql);
    await store.health();
    const deliver = createMessageNotificationDelivery({ store });
    writeWorkerLog("info", "worker_started", { pollIntervalMs, batchLimit, leaseSeconds, retryDelaySeconds });
    while (!stopping) {
      try {
        const result = await dispatchOutboxBatch({
          store,
          deliver,
          limit: batchLimit,
          leaseSeconds,
          retryDelaySeconds,
          onDeliveryFailure: (failure) => writeWorkerLog(
            failure.retryScheduled && !failure.retryScheduleErrorName ? "warn" : "error",
            "outbox_event_failed",
            failure,
          ),
        });
        if (result.claimed > 0) {
          writeWorkerLog(result.failed > 0 ? "warn" : "info", "outbox_batch_completed", result);
        }
        if (result.claimed === 0) await delay(pollIntervalMs);
      } catch (error) {
        // Driver exception messages can contain SQL details or infrastructure values.
        writeWorkerLog("error", "outbox_batch_failed", { errorName: safeErrorName(error) });
        await delay(pollIntervalMs);
      }
    }
  } finally {
    writeWorkerLog("info", "worker_stopping");
    await sql.end({ timeout: 5 });
  }
}

runWorker().catch((error) => {
  writeWorkerLog("error", "worker_failed_to_start", { errorName: safeErrorName(error) });
  process.exitCode = 1;
});
