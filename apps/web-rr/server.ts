import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { safeLogPath, writeLogLine } from "@bot-thk/web-http/log";
import { createRequestListener } from "@react-router/node";

/**
 * Production server for the prototype: Node.js `http` only — no Vercel service
 * bindings, no platform adapter, no Express.
 *
 * ADR 0012 requires the Web app to start on "standard Node.js server/container".
 * This file is the executable form of that requirement: it serves the Vite client
 * build as static files and hands everything else to React Router's own request
 * listener. Any host that can run `node server.ts` can run this app.
 */
// Repository-root `.env.local`, same contract as the Next.js app: shell values win.
const rootEnvFile = fileURLToPath(new URL("../../.env.local", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const buildDir = resolve(process.env.RR_BUILD_DIR ?? "build/client");
const serverBuildDir = resolve(process.env.RR_SERVER_BUILD_DIR ?? "build/server/index.js");
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "0.0.0.0";

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * Serve a build asset. Returns `false` when the URL is not a file this server
 * owns, so the request falls through to the framework handler.
 */
async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  if (pathname.endsWith("/")) return false;
  const extension = extname(pathname);
  if (!MIME[extension]) return false;

  // Contain the lookup inside the build directory: `..` segments must not escape.
  const candidate = resolve(join(buildDir, normalize(pathname)));
  if (!candidate.startsWith(buildDir + sep)) return false;

  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    const immutable = pathname.startsWith("/assets/");
    response.writeHead(200, {
      "content-type": MIME[extension] ?? "application/octet-stream",
      "content-length": stats.size,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    });
    if (method === "HEAD") {
      response.end();
      return true;
    }
    createReadStream(candidate).pipe(response);
    return true;
  } catch {
    return false;
  }
}

const build = (await import(serverBuildDir)) as unknown as Parameters<typeof createRequestListener>[0]["build"];
const handleRequest = createRequestListener({ build, mode: process.env.NODE_ENV ?? "production" });

/**
 * How long an accepted request may still run after a stop signal.
 *
 * A host that wants a process gone sends SIGTERM and later SIGKILL, and the
 * grace window has to be shorter than that gap — otherwise the platform decides
 * when the last response is cut, which is exactly what "graceful" is meant to
 * avoid. Render's documented gap is 10 s; see
 * docs/operations/host-qualification.md.
 */
const SHUTDOWN_GRACE_MS = 8_000;

/** Requests that have been accepted and have not finished yet. */
let inFlight = 0;
let shuttingDown = false;

/**
 * A cheap liveness target for a host health check: no rendering, no upstream
 * call, and never a page a crawler should keep.
 */
function serveHealthCheck(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
  });
  response.end(JSON.stringify({ status: "ok" }));
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const method = request.method ?? "GET";
  const target = request.url ?? "/";
  if (shuttingDown) {
    // Refuse new work outright: a draining process that keeps accepting is a
    // process whose shutdown never ends.
    response.writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "1",
      connection: "close",
    });
    response.end("Shutting down");
    return;
  }
  if (target === "/healthz" || target.startsWith("/healthz?")) {
    // Deliberately not logged: a host probes this every few seconds, and health
    // checks would otherwise be the loudest and least interesting line in the
    // drain — enough of them to bury the requests that actually matter.
    serveHealthCheck(response);
    return;
  }

  const startedAt = Date.now();
  inFlight += 1;
  let logged = false;
  const logCompletion = (): void => {
    if (logged) return;
    logged = true;
    // Only ever the path: query strings carry password-reset and verification
    // tokens, and a host's log retention is not where those belong.
    writeLogLine("http_request_completed", {
      method,
      path: safeLogPath(target),
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
  };
  response.on("close", () => {
    inFlight -= 1;
    logCompletion();
  });

  serveStatic(request, response)
    .then((served) => {
      if (!served) handleRequest(request, response);
    })
    .catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
    });
});

server.listen(port, host, () => {
  writeLogLine("server_listening", { host, port, pid: process.pid, node: process.version, buildDir });
});

function stop(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  writeLogLine("server_shutdown_started", { signal, inFlight });

  // Stop accepting, then drop idle keep-alive sockets: waiting out their
  // timeouts is the usual reason a "graceful" shutdown looks like a hang.
  server.close();
  server.closeIdleConnections();

  const finish = (forced: boolean): void => {
    writeLogLine("server_shutdown_complete", {
      signal,
      inFlight,
      durationMs: Date.now() - startedAt,
      forced,
    });
    if (forced) {
      // The grace window expired: cut the rest rather than let the platform do
      // it less politely.
      server.closeAllConnections();
      process.exit(0);
    }
    server.closeAllConnections();
    process.exitCode = 0;
    // Nothing should keep the loop alive now; if something does, do not hang
    // the deployment on it.
    setTimeout(() => process.exit(0), 500).unref();
  };

  if (inFlight === 0) {
    finish(false);
    return;
  }

  const deadline = setTimeout(() => finish(true), SHUTDOWN_GRACE_MS);
  deadline.unref();
  const drain = setInterval(() => {
    server.closeIdleConnections();
    if (inFlight > 0) return;
    clearInterval(drain);
    clearTimeout(deadline);
    finish(false);
  }, 25);
  drain.unref();
}

// SIGTERM is what a host sends before it stops or replaces the process; SIGINT
// is the developer at the keyboard. Both mean the same thing here.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stop(signal));
}
