import { createServer, type Server } from "node:http";
import { createPersistenceRuntime } from "../infrastructure/persistence-runtime.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { resolveOutboxRetryPolicy } from "./outbox-retry-policy.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";
import { createOutboxMetrics } from "./outbox-metrics.ts";

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(name + " must be an integer between " + min + " and " + max + ".");
  }
  return value;
}

const pollIntervalMs = integerSetting("OUTBOX_POLL_INTERVAL_MS", 1000, 100, 60000);
const batchLimit = integerSetting("OUTBOX_BATCH_LIMIT", 25, 1, 100);
const leaseSeconds = integerSetting("OUTBOX_LEASE_SECONDS", 60, 1, 3600);
const retryPolicy = resolveOutboxRetryPolicy({
  retryDelaySeconds: integerSetting("OUTBOX_RETRY_DELAY_SECONDS", 30, 1, 86400),
  maxRetryDelaySeconds: integerSetting("OUTBOX_MAX_RETRY_DELAY_SECONDS", 86400, 1, 86400),
  maxAttempts: integerSetting("OUTBOX_MAX_ATTEMPTS", 8, 1, 100),
});
// Worker metrics are opt-in and bind only to loopback by default.
const metricsPort = integerSetting("OUTBOX_METRICS_PORT", 0, 0, 65535);
const metricsHost = process.env.OUTBOX_METRICS_HOST ?? "127.0.0.1";
const metricsRefreshIntervalMs = integerSetting("OUTBOX_METRICS_REFRESH_INTERVAL_MS", 5000, 1000, 60000);
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "NonErrorThrow";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

function writeWorkerLog(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
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

function safeMetricsPath(request: import("node:http").IncomingMessage): string {
  try { return new URL(request.url ?? "/", "http://localhost").pathname; } catch { return "/not_found"; }
}

function createWorkerMetricsServer(metrics: ReturnType<typeof createOutboxMetrics>): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && safeMetricsPath(request) === "/metrics") {
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(metrics.render());
      return;
    }
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("Not Found\n");
  });
}

async function refreshBacklogMetrics(
  store: Awaited<ReturnType<typeof createPersistenceRuntime>>["adapter"],
  metrics: ReturnType<typeof createOutboxMetrics>,
) {
  metrics.recordBacklog(await store.outboxBacklog());
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function runWorker() {
  // The provider, not PostgreSQL specifically: the outbox is written by both
  // adapters and the SQLite one is the default, so requiring DATABASE_URL here
  // meant a default deployment queued message notifications forever and nobody
  // was told. Whatever `DATABASE_PROVIDER`/`DATABASE_URL` select, the drain runs
  // against the same adapter the API writes with.
  const runtime = await createPersistenceRuntime({ env: process.env });
  const store = runtime.adapter;
  const metrics = createOutboxMetrics();
  let metricsServer: Server | null = null;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await store.health();
    if (metricsPort > 0) {
      metricsServer = createWorkerMetricsServer(metrics);
      await listen(metricsServer, metricsPort, metricsHost);
      metricsServer.on("error", (error) => writeWorkerLog("error", "outbox_metrics_server_error", {
        errorName: safeErrorName(error),
      }));
      writeWorkerLog("info", "outbox_metrics_listening", { host: metricsHost, port: metricsPort });
      try {
        await refreshBacklogMetrics(store, metrics);
      } catch (error) {
        metrics.recordBacklogReadFailure();
        writeWorkerLog("warn", "outbox_metrics_refresh_failed", { errorName: safeErrorName(error) });
      }
    }
    const deliver = createMessageNotificationDelivery({ store });
    writeWorkerLog("info", "worker_started", {
      provider: runtime.provider,
      pollIntervalMs, batchLimit, leaseSeconds, ...retryPolicy,
      metricsEnabled: metricsPort > 0,
    });
    let lastMetricsRefreshAt = Date.now();
    while (!stopping) {
      try {
        const startedAt = process.hrtime.bigint();
        const result = await dispatchOutboxBatch({
          store,
          deliver,
          limit: batchLimit,
          leaseSeconds,
          ...retryPolicy,
          onDeliveryFailure: (failure) => writeWorkerLog(
            failure.retryScheduled && !failure.retryScheduleErrorName ? "warn" : "error",
            "outbox_event_failed",
            failure,
          ),
        });
        metrics.recordBatch(result, Number(process.hrtime.bigint() - startedAt) / 1_000_000);
        const refreshDue = metricsServer !== null && Date.now() - lastMetricsRefreshAt >= metricsRefreshIntervalMs;
        if (refreshDue) {
          lastMetricsRefreshAt = Date.now();
          try {
            await refreshBacklogMetrics(store, metrics);
          } catch (error) {
            metrics.recordBacklogReadFailure();
            writeWorkerLog("warn", "outbox_metrics_refresh_failed", { errorName: safeErrorName(error) });
          }
        }
        if (result.claimed > 0) {
          writeWorkerLog(result.failed > 0 ? "warn" : "info", "outbox_batch_completed", result);
        }
        if (result.claimed === 0) await delay(pollIntervalMs);
      } catch (error) {
        metrics.recordBatchFailure();
        // Driver exception messages can contain SQL details or infrastructure values.
        writeWorkerLog("error", "outbox_batch_failed", { errorName: safeErrorName(error) });
        await delay(pollIntervalMs);
      }
    }
  } finally {
    writeWorkerLog("info", "worker_stopping");
    const server = metricsServer;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
    await runtime.close();
  }
}

runWorker().catch((error) => {
  writeWorkerLog("error", "worker_failed_to_start", { errorName: safeErrorName(error) });
  process.exitCode = 1;
});
