import { createServer } from "node:http";
import { createYoga } from "graphql-yoga";
import { createApiSchema } from "./transport/graphql/schema.mjs";
import { createRestHandler } from "./transport/rest/handler.mjs";
import { createAuthContext } from "./security/authentication.mjs";
import { createApplicationServices } from "./application/services.mjs";
import { assertPersistenceAdapter } from "./application/persistence-ports.mjs";
import { createPersistenceRuntime } from "./infrastructure/persistence-runtime.mjs";

/**
 * Identity is accepted only after server-side bearer verification.
 * Domain resolvers must check database membership before exposing or mutating
 * private resources. A client-supplied senderId is not part of the mutation API.
 */
export function createApiServer({ env = process.env, store = null, applicationServices = null } = {}) {
  const services = applicationServices ?? (store ? createApplicationServices({ persistence: store }) : null);
  const handleRest = createRestHandler({ services });
  const yoga = createYoga({
    schema: createApiSchema(),
    graphqlEndpoint: "/graphql",
    graphiql: false,
    context: async ({ request }) => {
      const auth = createAuthContext(request, env);
      if (auth.user?.sessionId && services && await services.isSessionRevoked(auth.user.sessionId)) {
        return { user: null, services };
      }
      return { ...auth, services };
    },
  });

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
    yoga(request, response);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const start = async () => {
    const env = process.env;
    let services = null;
    let closePersistence = async () => {};
    if (env.DATABASE_URL || env.DATABASE_PROVIDER) {
      const runtime = await createPersistenceRuntime({ provider: env.DATABASE_PROVIDER ?? "postgres", env });
      assertPersistenceAdapter(runtime.adapter);
      services = createApplicationServices({ persistence: runtime.adapter });
      await services.health();
      closePersistence = runtime.close;
    }
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
