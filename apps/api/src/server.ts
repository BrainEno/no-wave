import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRestHandler } from "./transport/rest/handler.ts";
import { collectionReadTimeout } from "./transport/rest/collection-read-budget.ts";
import { configureJsonCollectionOutput, jsonCollectionOutputSettings } from "./transport/rest/json-collection-budget.ts";
import { createApplicationServices } from "./application/services.ts";
import { assertPersistenceAdapter, type PersistenceAdapterContract } from "./application/persistence-ports.ts";
import { createPersistenceRuntime, describePersistenceRuntime } from "./infrastructure/persistence-runtime.ts";
import { createHttpObservability, writeStructuredLog } from "./infrastructure/http-observability.ts";
import { redactDiagnostic, secretValues } from "./infrastructure/log-redaction.ts";
import { createMediaAssetService } from "./application/media-assets.ts";
import type { ApplicationServices } from "./application/services.ts";
import { createMediaObjectStorage } from "./infrastructure/media-storage.ts";
import { accessIssuerConfiguration } from "./security/authentication.ts";
import { createApiReadiness } from "./infrastructure/api-readiness.ts";
import { HttpCollectionAdmission, httpCollectionAdmissionSettings } from "./infrastructure/http-collection-admission.ts";
import { createHttpLifecycle } from "./infrastructure/http-lifecycle.ts";
import { apiHttpSettings, readinessSettings, shutdownSettings } from "./infrastructure/service-settings.ts";
import { isMainModule } from "./infrastructure/entrypoint.ts";
import { guardProcessFailures } from "./infrastructure/process-failures.ts";
import { createStartupDeadline } from "./infrastructure/startup-deadline.ts";

const apiRuntimes = new WeakMap<Server, { lifecycle: ReturnType<typeof createHttpLifecycle>; readiness: ReturnType<typeof createApiReadiness>; collections: HttpCollectionAdmission }>();

/** REST is the only business HTTP transport exposed by this API. */
export function createApiServer({
  env = process.env,
  store = null,
  applicationServices = null,
  logger = writeStructuredLog,
  observability: suppliedObservability = null,
  mediaAssets = null,
}: {
  env?: NodeJS.ProcessEnv;
  store?: PersistenceAdapterContract | null;
  applicationServices?: ApplicationServices | null;
  logger?: typeof writeStructuredLog;
  observability?: ReturnType<typeof createHttpObservability> | null;
  mediaAssets?: ReturnType<typeof createMediaAssetService> | null;
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
  // Per-request observations, so the transport can name the route that matched.
  // A WeakMap keyed by the request: nothing to clean up, and a finished request
  // cannot keep an observation alive.
  const observations = new WeakMap<IncomingMessage, ReturnType<typeof observability.beginRequest>>();
  const collections = new HttpCollectionAdmission(httpCollectionAdmissionSettings(env));
  const handleRest = createRestHandler({
    collectionAdmission: collections,
    services,
    env,
    mediaAssets,
    onMailDelivery: observability.observeMailDelivery,
    onBackgroundFailure,
    onRouteMatched: (request, routeId) => observations.get(request)?.assignRoute(routeId),
  });

  const readiness = createApiReadiness({ services, env });
  const http = apiHttpSettings(env);
  const collectionOutput = jsonCollectionOutputSettings(env);
  const server = createServer({ ...http, connectionsCheckingInterval: Math.min(1000, http.headersTimeout, http.requestTimeout) }, async (request, response) => {
    const startedAt = process.hrtime.bigint();
    const observation = observability.beginRequest(request, response);
    configureJsonCollectionOutput(response, collectionOutput);
    observations.set(request, observation);
    let errorName: string | undefined;
    const finish = (statusCode = response.statusCode) => observation.finish({
      statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      ...(errorName ? { errorName } : {}),
    });
    response.once("finish", () => finish());
    response.once("close", () => {
      if (!response.writableFinished) finish(499);
    });
    if (!lifecycle.admit(request, response)) return;
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const probeMethod = request.method === "GET" || request.method === "HEAD";
      if (probeMethod && pathname === "/health") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "ok", service: "api" }));
        return;
      }
      if (probeMethod && pathname === "/metrics") {
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
        response.end(observability.renderMetrics() + collections.renderMetrics() + await readiness.renderMetrics());
        return;
      }
      if (probeMethod && pathname === "/ready") {
        const status = await readiness.read();
        const ready = status.status === "ready";
        response.writeHead(ready ? 200 : 503, {
          "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
          ...(ready ? {} : { "retry-after": "1" }),
        });
        response.end(JSON.stringify(status));
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
  const lifecycle = createHttpLifecycle(server, { env, log: logger });
  apiRuntimes.set(server, { lifecycle, readiness, collections });
  server.once("close", () => readiness.close());
  return server;
}

export function shutdownApiServer(server: Server, {
  closePersistence = () => {}, closeMedia = () => {}, signal = "requested",
}: { closePersistence?: () => unknown; closeMedia?: () => unknown; signal?: string } = {}) {
  const runtime = apiRuntimes.get(server);
  if (!runtime) throw new TypeError("The server must be created by createApiServer.");
  runtime.readiness.close();
  runtime.collections.stop();
  return runtime.lifecycle.stop([
    { name: "readiness", close: runtime.readiness.close },
    { name: "persistence", close: closePersistence },
    { name: "media", close: closeMedia },
  ], signal);
}

export async function runApiProcess(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  accessIssuerConfiguration(env);
  apiHttpSettings(env);
  jsonCollectionOutputSettings(env);
  collectionReadTimeout(env);
  httpCollectionAdmissionSettings(env);
  readinessSettings(env);
  const shutdown = shutdownSettings(env);
  type Runtime = Awaited<ReturnType<typeof createPersistenceRuntime>>;
  let runtime: Runtime | null = null;
  let acquisition: Promise<Runtime> | null = null;
  let acquisitionFailed = false;
  let mediaStorage: ReturnType<typeof createMediaObjectStorage> = null;
  let server: Server | null = null;
  let stopPromise: ReturnType<ReturnType<typeof createHttpLifecycle>["stop"]> | null = null;
  let termination: Promise<never> | null = null;
  let fatalFailure = false;
  let cancelStartupDeadline = () => {};

  function stop(signal: string) {
    if (stopPromise) return stopPromise;
    cancelStartupDeadline();
    if (server) {
      stopPromise = shutdownApiServer(server, { closePersistence: () => runtime!.close(), closeMedia: () => mediaStorage?.close(), signal });
    } else {
      // A signal can arrive before the provider returns its teardown function.
      // Allow acquisition only the drain share, then reserve time for closing
      // an acquired pool. Never log a successful close for an unknown resource.
      const startup = createHttpLifecycle(null, { env, log: writeStructuredLog });
      stopPromise = startup.stop([
        ...(!acquisitionFailed ? [{ name: "persistence" as const, close: () => {
          if (!runtime) throw new Error("Persistence was not acquired before the shutdown deadline.");
          return runtime.close();
        } }] : []),
        ...(mediaStorage ? [{ name: "media" as const, close: () => mediaStorage?.close() }] : []),
      ], signal, () => acquisition?.then(() => {}));
    }
    return stopPromise;
  }
  function terminate(signal: string, failed = false): void {
    fatalFailure ||= failed;
    if (!termination) termination = stop(signal).then(report => process.exit(fatalFailure ? 1 : report.exitCode));
  }
  const onInt = () => terminate("SIGINT"), onTerm = () => terminate("SIGTERM");
  // Install before the first asynchronous provider step, not after listen().
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const failures = guardProcessFailures({ prefix: "api", deadlineMs: shutdown.deadlineMs, log: writeStructuredLog,
    shutdown: source => { terminate(source, true); return termination; } });
  const detachSignals = () => {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); failures.dispose();
  };
  try {
    cancelStartupDeadline = createStartupDeadline({ env, prefix: "api", log: writeStructuredLog,
      onTimeout: () => terminate("startup-timeout", true) });
    acquisition = createPersistenceRuntime({ env }).then(value => { runtime = value; return value; }, error => {
      acquisitionFailed = true;
      throw error;
    });
    const acquired = await acquisition;
    if (termination) return await termination;
    assertPersistenceAdapter(acquired.adapter);
    const observability = createHttpObservability();
    mediaStorage = createMediaObjectStorage(env);
    const mediaAssets = mediaStorage ? createMediaAssetService({ store: acquired.adapter, storage: mediaStorage }) : null;
    const services = createApplicationServices({
      persistence: acquired.adapter, env,
      onPersistenceOperation: observability.observePersistenceOperation,
      onBackgroundFailure: observability.observeBackgroundFailure,
    });
    await services.health();
    if (termination) return await termination;
    const port = Number(env.PORT ?? 4000);
    const host = env.HOST ?? "0.0.0.0";
    server = createApiServer({ env, applicationServices: services, observability, mediaAssets });
    const running = server;
    await new Promise<void>((resolve, reject) => {
      const error = (failure: Error) => { running.off("listening", listening); reject(failure); };
      const listening = () => { running.off("error", error); resolve(); };
      running.once("error", error);
      running.once("listening", listening);
      running.listen(port, host);
    });
    if (termination) return await termination;
    running.on("error", error => {
      writeStructuredLog({ level: "error", event: "api_listener_failed", errorName: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error" });
      terminate("listener-error", true);
    });
    running.once("close", () => {
      if (stopPromise) return;
      writeStructuredLog({ level: "error", event: "api_listener_closed", activeRequests: apiRuntimes.get(running)?.lifecycle.activeRequests() ?? 0 });
      terminate("listener-closed", true);
    });
    const address = server.address();
    const actualPort = address && typeof address !== "string" ? address.port : port;
    cancelStartupDeadline();
    writeStructuredLog({ ...describePersistenceRuntime({ provider: acquired.provider }), host, port: actualPort });
    return running;
  } catch (error) {
    if (termination) return await termination;
    await stop("startup-failure");
    detachSignals();
    throw error;
  }
}

export function reportApiStartupFailure(error: unknown): void {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const errorMessage = error instanceof Error ? redactDiagnostic(error.message, { secrets: secretValues() }) : null;
  writeStructuredLog({ level: "error", event: "api_startup_failed", errorName, ...(errorMessage ? { errorMessage } : {}) });
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  runApiProcess().catch(error => { reportApiStartupFailure(error); process.exit(1); });
}
