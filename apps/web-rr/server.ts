import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

const server = createServer((request, response) => {
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
  process.stdout.write(`web-rr listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not let a hung keep-alive connection block shutdown.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
