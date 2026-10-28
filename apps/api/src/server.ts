import { createServer } from "node:http";
import { createRestHandler } from "./transport/rest/handler.ts";
import { createApplicationServices } from "./application/services.ts";
import { assertPersistenceAdapter } from "./application/persistence-ports.ts";
import { createPersistenceRuntime } from "./infrastructure/persistence-runtime.ts";
import { createHttpObservability, writeStructuredLog } from "./infrastructure/http-observability.ts";

/** REST is the only business HTTP transport exposed by this API. */
export function createApiServer({
  env = process.env,
  store = null,
  applicationServices = null,
  logger = writeStructuredLog,
  observability: suppliedObservability = null,
} = {}) {
  const observability = suppliedObservability ?? createHttpObservability({ logger });
  const services = applicationServices ?? (store
    ? createApplicationServices({ persistence: store, onPersistenceOperation: observability.observePersistenceOperation })
    : null);
  const handleRest = createRestHandler({ services, env });

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
    const services = createApplicationServices({ persistence: runtime.adapter });
    await services.health();
    const closePersistence = runtime.close;
    const port = Number(env.PORT ?? 4000);
    const host = env.HOST ?? "0.0.0.0";
    const server = createApiServer({ env, applicationServices: services });
    server.listen(port, host, () => {
      process.stdout.write(`BOT THK API listening on http://${host}:${port}\n`);
    });
    const shutdown = () => {
      server.close(async () => {
        await closePersistence();
        process.exit(0);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  };
  start().catch((error) => {
    process.stderr.write(`BOT THK API startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
