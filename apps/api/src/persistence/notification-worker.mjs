import { createPostgresClient, createPostgresStore } from "./postgres.mjs";
import { dispatchOutboxBatch } from "./outbox-worker.mjs";
import { createMessageNotificationDelivery } from "./message-notification-delivery.mjs";

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
    process.stdout.write("Notification outbox worker started.\n");
    while (!stopping) {
      try {
        const result = await dispatchOutboxBatch({
          store, deliver, limit: batchLimit, leaseSeconds, retryDelaySeconds,
        });
        if (result.claimed > 0) process.stdout.write(`Outbox batch: ${JSON.stringify(result)}\n`);
        if (result.claimed === 0) await delay(pollIntervalMs);
      } catch (error) {
        process.stderr.write(`Outbox batch failed: ${error.message}\n`);
        await delay(pollIntervalMs);
      }
    }
  } finally {
    process.stdout.write("Notification outbox worker stopping.\n");
    await sql.end({ timeout: 5 });
  }
}

runWorker().catch((error) => {
  process.stderr.write(`Notification worker failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
