import { createServer } from "node:http";
import { createHttpLifecycle } from "./http-lifecycle.ts";
import { workerHealthSettings } from "./service-settings.ts";
import type { createWorkerReadiness } from "./worker-readiness.ts";

type Readiness = ReturnType<typeof createWorkerReadiness>;
type LifecycleLog = NonNullable<Parameters<typeof createHttpLifecycle>[1]>["log"];

/** This listener serves only anonymous, bounded process state. It never opens
 * the database on behalf of a health probe and does not expose worker metrics. */
export function createWorkerHealth({
  readiness, env = process.env, log,
}: { readiness: Readiness; env?: NodeJS.ProcessEnv; log?: LifecycleLog }) {
  const config = workerHealthSettings(env);
  const server = createServer({ headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (request, response) => {
    if (!lifecycle.admit(request, response)) return;
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    const send = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(405, { status: "method_not_allowed" });
      return;
    }
    let pathname: string;
    try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; }
    catch { send(400, { status: "bad_request" }); return; }
    if (pathname === "/health") {
      send(200, { status: "ok", service: "notification-worker" });
      return;
    }
    if (pathname === "/ready") {
      const status = readiness.snapshot();
      const ready = status.status === "ready";
      if (!ready) response.setHeader("retry-after", "1");
      send(ready ? 200 : 503, status);
      return;
    }
    send(404, { status: "not_found" });
  });
  const lifecycle = createHttpLifecycle(server, { env, prefix: "notification_worker", ...(log ? { log } : {}) });
  let listening: Promise<number | null> | null = null;
  function listen(): Promise<number | null> {
    if (listening) return listening;
    listening = (async () => {
      if (!config.enabled) return null;
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(config.port, config.host);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The worker did not acquire a health listener.");
      return address.port;
    })();
    return listening;
  }
  return Object.freeze({ server, config, listen, stop: lifecycle.stop });
}
