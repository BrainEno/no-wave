import { createServer } from "node:http";
import { createRestHandler } from "./transport/rest/handler.ts";
import { createApplicationServices } from "./application/services.ts";
import { assertPersistenceAdapter } from "./application/persistence-ports.ts";
import { createPersistenceRuntime } from "./infrastructure/persistence-runtime.ts";

/** REST is the only business HTTP transport exposed by this API. */
export function createApiServer({ env = process.env, store = null, applicationServices = null } = {}) {
  const services = applicationServices ?? (store ? createApplicationServices({ persistence: store }) : null);
  const handleRest = createRestHandler({ services, env });

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ status: "ok", service: "api" }));
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
      process.stdout.write(`BOT THK API listening on http://${host}:${port}\\n`);
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
    process.stderr.write(`BOT THK API startup failed: ${error.message}\\n`);
    process.exitCode = 1;
  });
}
