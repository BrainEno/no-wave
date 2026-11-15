import { createServer, type Server } from "node:http";
import { createPersistenceRuntime } from "../infrastructure/persistence-runtime.ts";
import { dispatchOutboxBatch } from "./outbox-worker.ts";
import { resolveOutboxRetryPolicy } from "./outbox-retry-policy.ts";
import { createMessageNotificationDelivery } from "./message-notification-delivery.ts";
import { createOutboxMetrics } from "./outbox-metrics.ts";

import { setImmediate as yieldToEventLoop, setTimeout as delay } from "node:timers/promises";
import { createWorkerReadiness } from "../infrastructure/worker-readiness.ts";
import { createWorkerHealth } from "../infrastructure/worker-health.ts";
import { integerSetting, shutdownSettings } from "../infrastructure/service-settings.ts";
import { isMainModule } from "../infrastructure/entrypoint.ts";
import { guardProcessFailures } from "../infrastructure/process-failures.ts";
import { createOutboxBacklogSampler } from "../infrastructure/outbox-backlog.ts";
import { createStartupDeadline } from "../infrastructure/startup-deadline.ts";

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

function createWorkerMetricsServer(metrics: ReturnType<typeof createOutboxMetrics>, readiness: ReturnType<typeof createWorkerReadiness>, backlog: ReturnType<typeof createOutboxBacklogSampler>): Server {
  return createServer({ headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    if ((request.method === "GET" || request.method === "HEAD") && safeMetricsPath(request) === "/metrics") {
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : metrics.render() + readiness.renderMetrics() + backlog.renderMetrics());
      return;
    }
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("Not Found\n");
  });
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

export async function runNotificationWorkerProcess(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const setting = (name: string, fallback: number, min: number, max: number) => integerSetting(env, name, fallback, min, max);
  const pollIntervalMs = setting("OUTBOX_POLL_INTERVAL_MS", 1000, 100, 60_000);
  const batchLimit = setting("OUTBOX_BATCH_LIMIT", 25, 1, 100);
  const leaseSeconds = setting("OUTBOX_LEASE_SECONDS", 60, 1, 3600);
  const retryPolicy = resolveOutboxRetryPolicy({
    retryDelaySeconds: setting("OUTBOX_RETRY_DELAY_SECONDS", 30, 1, 86400),
    maxRetryDelaySeconds: setting("OUTBOX_MAX_RETRY_DELAY_SECONDS", 86400, 1, 86400),
    maxAttempts: setting("OUTBOX_MAX_ATTEMPTS", 8, 1, 100),
  });
  const metricsPort = setting("OUTBOX_METRICS_PORT", 0, 0, 65535);
  const metricsHost = env.OUTBOX_METRICS_HOST ?? "127.0.0.1";
  const metricsRefreshIntervalMs = setting("OUTBOX_METRICS_REFRESH_INTERVAL_MS", 5000, 1000, 60_000);
  const metricsTimeoutMs = setting("OUTBOX_METRICS_TIMEOUT_MS", 500, 10, 5000);
  const shutdown = shutdownSettings(env);
  const readiness = createWorkerReadiness({ pollIntervalMs, leaseSeconds });
  const health = createWorkerHealth({ readiness, env, log: entry => writeWorkerLog(entry.level, entry.event, entry) });
  const metrics = createOutboxMetrics();
  const controller = new AbortController();
  type Runtime = Awaited<ReturnType<typeof createPersistenceRuntime>>;
  let runtime: Runtime | null = null;
  let acquisition: Promise<Runtime> | null = null;
  let acquisitionFailed = false;
  let metricsServer: Server | null = null;
  let backlogSampler: ReturnType<typeof createOutboxBacklogSampler> | null = null;
  let loop: Promise<void> | null = null;
  let stopPromise: ReturnType<typeof health.stop> | null = null;
  let finishStop!: () => void;
  const stopCompleted = new Promise<void>(resolve => { finishStop = resolve; });
  let stopSignal = "completed";
  let fatalFailure = false;
  let startupSucceeded = false;
  let finishStartup!: () => void;
  const startupCompleted = new Promise<void>(resolve => { finishStartup = resolve; });
  let cancelStartupDeadline = () => {};

  function beginStop(): ReturnType<typeof health.stop> {
    if (stopPromise) return stopPromise;
    cancelStartupDeadline();
    readiness.stopping();
    controller.abort();
    backlogSampler?.close();
    writeWorkerLog("info", "worker_stopping");
    stopPromise = health.stop([
      ...(acquisition && !acquisitionFailed ? [{ name: "persistence" as const, close: async () => {
        if (!runtime) throw new Error("Persistence was not acquired before the worker shutdown deadline.");
        await runtime.close();
      } }] : []),
      ...(metricsServer ? [{ name: "metrics" as const, close: async () => {
        if (!metricsServer?.listening) return;
        await new Promise<void>(resolve => { metricsServer!.close(() => resolve()); metricsServer!.closeAllConnections(); });
      } }] : []),
    ], stopSignal, async () => { await startupCompleted; await (loop ?? Promise.resolve()); }).then(report => {
      readiness.stopped();
      finishStop();
      return report;
    });
    return stopPromise;
  }
  function requestStop(signal: string): void {
    if (controller.signal.aborted) return;
    stopSignal = signal;
    // Start the same absolute lifecycle immediately, even before a provider
    // hands back ownership. Unknown resources cannot be logged as closed.
    void beginStop();
  }
  function listenerClosed(event: "worker_health_listener_closed" | "outbox_metrics_listener_closed"): void {
    if (controller.signal.aborted) return;
    fatalFailure = true;
    const state = readiness.snapshot();
    writeWorkerLog("error", event, { phase: state.phase, completedBatches: state.completedBatches });
    requestStop(event);
  }
  const onInt = () => requestStop("SIGINT"), onTerm = () => requestStop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const failures = guardProcessFailures({ prefix: "notification_worker", deadlineMs: shutdown.deadlineMs,
    log: entry => writeWorkerLog(entry.level, entry.event, entry),
    shutdown: source => { fatalFailure = true; requestStop(source); return stopCompleted; } });
  const idle = async () => {
    try { await delay(pollIntervalMs, undefined, { signal: controller.signal }); }
    catch (error) { if (!controller.signal.aborted) throw error; }
  };

  let report: Awaited<ReturnType<typeof health.stop>> | null = null;
  const run = async () => {
    cancelStartupDeadline = createStartupDeadline({ env, prefix: "notification_worker",
      log: entry => writeWorkerLog(entry.level, entry.event, entry),
      onTimeout: () => { fatalFailure = true; requestStop("startup-timeout"); } });
    // Liveness and "starting" readiness are available while a real provider
    // acquisition/migration check is blocked. Probes never wait on the DB.
    const healthPort = await health.listen();
    if (controller.signal.aborted) return;
    if (healthPort !== null) {
      health.server.on("error", error => {
        fatalFailure = true;
        writeWorkerLog("error", "worker_health_server_error", { errorName: safeErrorName(error) });
        requestStop("health-server-error");
      });
      health.server.once("close", () => listenerClosed("worker_health_listener_closed"));
      writeWorkerLog("info", "worker_health_listening", { host: health.config.host, port: healthPort });
    }
    acquisition = createPersistenceRuntime({ env }).then(value => { runtime = value; return value; }, error => {
      acquisitionFailed = true;
      throw error;
    });
    const acquired = await Promise.race([acquisition, stopCompleted.then(() => null)]);
    if (!acquired || controller.signal.aborted) return;
    const store = acquired.adapter;
    const healthy = await Promise.race([Promise.resolve().then(() => store.health()), stopCompleted]);
    if (controller.signal.aborted) return;
    if (healthy !== true) throw new Error("Worker persistence health did not succeed.");
    if (metricsPort > 0) {
      backlogSampler = createOutboxBacklogSampler({ metrics, refreshIntervalMs: metricsRefreshIntervalMs, timeoutMs: metricsTimeoutMs,
        read: () => store.outboxBacklog(), onFailure: failure => writeWorkerLog("warn", "outbox_metrics_refresh_failed", failure) });
      metricsServer = createWorkerMetricsServer(metrics, readiness, backlogSampler);
      await listen(metricsServer, metricsPort, metricsHost);
      if (controller.signal.aborted) return;
      metricsServer.on("error", error => {
        fatalFailure = true;
        writeWorkerLog("error", "outbox_metrics_server_error", { errorName: safeErrorName(error) });
        requestStop("metrics-server-error");
      });
      metricsServer.once("close", () => listenerClosed("outbox_metrics_listener_closed"));
      writeWorkerLog("info", "outbox_metrics_listening", { host: metricsHost, port: metricsPort });
      backlogSampler.start();
    }
    if (controller.signal.aborted) return;
    const deliver = createMessageNotificationDelivery({ store });
    writeWorkerLog("info", "worker_started", { provider: acquired.provider, pollIntervalMs, batchLimit, leaseSeconds,
      ...retryPolicy, metricsEnabled: metricsPort > 0, healthEnabled: healthPort !== null });
    startupSucceeded = true;
    let readyReported = false;
    const runLoop = async () => {
      while (!controller.signal.aborted) {
        readiness.beginBatch();
        const startedAt = performance.now();
        let result: Awaited<ReturnType<typeof dispatchOutboxBatch>>;
        try {
          result = await dispatchOutboxBatch({ store, deliver, limit: batchLimit, leaseSeconds, ...retryPolicy,
            signal: controller.signal,
            onDeliveryFailure: failure => writeWorkerLog(failure.retryScheduled && !failure.retryScheduleErrorName ? "warn" : "error", "outbox_event_failed", failure),
          });
        } catch (error) {
          readiness.failBatch();
          metrics.recordBatchFailure();
          writeWorkerLog("error", "outbox_batch_failed", { errorName: safeErrorName(error) });
          await idle();
          continue;
        }
        readiness.finishBatch(result);
        metrics.recordBatch(result, performance.now() - startedAt);
        if (!readyReported && !controller.signal.aborted) {
          readyReported = true;
          cancelStartupDeadline();
          writeWorkerLog("info", "worker_ready", { provider: runtime!.provider });
        }
        if (result.claimed > 0) writeWorkerLog(result.failed > 0 ? "warn" : "info", "outbox_batch_completed", result);
        if (result.claimed === 0) await idle();
        // SQLite methods resolve synchronously. Yield between nonempty batches
        // so a large backlog cannot starve health probes, timers or SIGTERM.
        else await yieldToEventLoop();
      }
    };
    loop = runLoop();
    finishStartup();
    await Promise.race([loop, stopCompleted]);
  };
  try { await run(); }
  catch (error) {
    if (!controller.signal.aborted) {
      fatalFailure = true;
      writeWorkerLog("error", startupSucceeded ? "worker_run_failed" : "worker_failed_to_start", { errorName: safeErrorName(error) });
    }
  } finally {
    finishStartup();
    report = await beginStop();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    failures.dispose();
  }
  return fatalFailure || report.forced ? 1 : report.exitCode;
}

export function reportWorkerStartupFailure(error: unknown): void {
  const setting = error instanceof Error
    ? /^(OUTBOX_[A-Z_]+|SHUTDOWN_[A-Z_]+|SERVICE_STARTUP_TIMEOUT_MS|maxRetryDelaySeconds|retryDelaySeconds|maxAttempts)\b/.exec(error.message)?.[1]
    : undefined;
  writeWorkerLog("error", "worker_failed_to_start", { errorName: safeErrorName(error), ...(setting ? { configurationField: setting } : {}) });
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  runNotificationWorkerProcess().then(code => { process.exitCode = code; if (code !== 0) process.exit(code); }, error => {
    reportWorkerStartupFailure(error);
    process.exit(1);
  });
}
