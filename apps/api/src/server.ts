import { createServer } from "node:http";
import { createRestHandler } from "./transport/rest/handler.ts";
import { createApplicationServices } from "./application/services.ts";
import { assertPersistenceAdapter } from "./application/persistence-ports.ts";
import { createPersistenceRuntime, describePersistenceRuntime } from "./infrastructure/persistence-runtime.ts";
import { createHttpObservability, writeStructuredLog } from "./infrastructure/http-observability.ts";
import { createMediaAssetService } from "./application/media-assets.ts";
import { createMediaObjectStorage } from "./infrastructure/media-storage.ts";

/** REST is the only business HTTP transport exposed by this API. */
export function createApiServer({
  env = process.env,
  store = null,
  applicationServices = null,
  logger = writeStructuredLog,
  observability: suppliedObservability = null,
  mediaAssets = null,
} = {}) {
  const observability = suppliedObservability ?? createHttpObservability({ logger });
  // Audit F-22: the cleanup sweeps and the deletion notices are background work,
  // so their failures have no status code to appear in. They go to the same
  // counter and log line as account mail — one call, so the two cannot disagree —
  // and the log carries the error *class* only: a driver message can contain a
  // connection string.
  const onBackgroundFailure = observability.observeBackgroundFailure;
  // The environment reaches the service facade too: the retention window for
  // deleted works is read there, and a test (or an embedded host) that supplies
  // its own `env` must see its own value, not the process's.
  const services = applicationServices ?? (store
    ? createApplicationServices({
        persistence: store,
        onPersistenceOperation: observability.observePersistenceOperation,
        onBackgroundFailure,
        env,
      })
    : null);
  // Mail delivery is invisible in the HTTP status code by design (a recovery
  // request answers 202 whether or not the mail went out), so the counter is the
  // only thing an alert can rule on.
  const handleRest = createRestHandler({
    services,
    env,
    mediaAssets,
    onMailDelivery: observability.observeMailDelivery,
    onBackgroundFailure,
  });

  return createServer(async (request, response) => {
    const startedAt = process.hrtime.bigint();
    const observation = observability.beginRequest(request, response);
    let errorName;
    const finish = (statusCode = response.statusCode) => observation.finish({
      statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      ...(errorName ? { errorName } : {}),
    });
    response.once("finish", () => finish());
    response.once("close", () => {
      if (!response.writableFinished) finish(499);
    });
    try {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ status: "ok", service: "api" }));
      return;
    }
    if (request.method === "GET" && new URL(request.url ?? "/", "http://localhost").pathname === "/metrics") {
      if (env.API_METRICS_ENABLED !== "true") {
        response.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({
          error: { code: "NOT_FOUND", message: "The requested route was not found." },
        }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(observability.renderMetrics());
      return;
    }
    if (request.method === "GET" && request.url === "/ready") {
      try {
        if (!services || typeof services.health !== "function") throw new Error("Persistence is not configured.");
        await services.health();
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "ready", service: "api", persistence: "ok" }));
      } catch {
        response.writeHead(503, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "not_ready", service: "api", persistence: "unavailable" }));
      }
      return;
    }
    if (await handleRest(request, response)) return;

    // Unknown non-versioned paths are not routed to another transport.
    response.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      error: { code: "NOT_FOUND", message: "The requested route was not found." },
    }));
    } catch (error) {
      errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
        ? error.name
        : "Error";
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({
          error: { code: "INTERNAL_SERVER_ERROR", message: "The request could not be completed." },
        }));
      } else {
        response.destroy();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const start = async () => {
    const env = process.env;
    const runtime = await createPersistenceRuntime({ env });
    assertPersistenceAdapter(runtime.adapter);
    const observability = createHttpObservability();
    const mediaStorage = createMediaObjectStorage(env);
    const mediaAssets = mediaStorage ? createMediaAssetService({ store: runtime.adapter, storage: mediaStorage }) : null;
    const services = createApplicationServices({
      persistence: runtime.adapter,
      onPersistenceOperation: observability.observePersistenceOperation,
      onBackgroundFailure: observability.observeBackgroundFailure,
    });
    await services.health();
    const closePersistence = runtime.close;
    const port = Number(env.PORT ?? 4000);
    const host = env.HOST ?? "0.0.0.0";
    const server = createApiServer({ env, applicationServices: services, observability, mediaAssets });
    server.listen(port, host, () => {
      const runtimeNotice = describePersistenceRuntime({ provider: runtime.provider });
      writeStructuredLog({ ...runtimeNotice, host, port });
    });
    const shutdown = () => {
      server.close(async () => {
        await closePersistence();
        mediaStorage?.close();
        process.exit(0);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  };
  start().catch((error) => {
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
      ? error.name
      : "Error";
    // The message is the whole point of this line: an API that cannot start
    // otherwise reports only "Error", which sends you to the debugger to find
    // out that a migration is pending or the database is unreachable. Capped,
    // and never the stack — but see the note about connection strings in
    // `docs/audit/backend-review-2026-11.md`.
    writeStructuredLog({
      level: "error",
      event: "api_startup_failed",
      errorName,
      ...(error instanceof Error ? { errorMessage: error.message.slice(0, 500) } : {}),
    });
    process.exitCode = 1;
  });
}
