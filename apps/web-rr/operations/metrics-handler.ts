import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type MetricsOptions = { path: string; credentialName: string; outputLimit: number; disallowedCredentials: readonly (string | undefined)[] };
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** Shared protection for operational endpoints, not an application authentication path. */
export function createProtectedMetricsHandler(env: Readonly<Record<string, string | undefined>>, options: MetricsOptions):
  (request: IncomingMessage, response: ServerResponse, render: () => string) => boolean {
  const token = env[options.credentialName];
  if (token !== undefined && !TOKEN_PATTERN.test(token)) throw new Error(`${options.credentialName} must be a separate opaque operations credential.`);
  if (token && options.disallowedCredentials.some(secret => secret === token)) {
    throw new Error(`${options.credentialName} must not reuse an application credential.`);
  }
  const digest = (value: string) => createHash("sha256").update(`no-wave/${options.path}/v1\0`).update(value).digest();
  const expected = token === undefined ? null : digest(token);
  let windowAt = performance.now();
  let requests = 0;
  return (request, response, render) => {
    const target = request.url ?? "/";
    if (target.split("?")[0] !== options.path) return false;
    const refuse = (status: number, message: string, extra: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...extra });
      response.end(request.method === "HEAD" ? undefined : message);
      return true;
    };
    if (!expected) return refuse(404, "Not Found");
    if (target !== options.path) return refuse(400, "Query parameters are not accepted.");
    const supplied = request.headers.authorization;
    const match = typeof supplied === "string" ? /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(supplied) : null;
    if (!match || !timingSafeEqual(expected, digest(match[1]!))) return refuse(401, "Unauthorized");
    if (request.method !== "GET" && request.method !== "HEAD") return refuse(405, "Method Not Allowed", { allow: "GET, HEAD" });
    const now = performance.now();
    if (now - windowAt >= 60_000) { windowAt = now; requests = 0; }
    if (requests >= 60) return refuse(429, "Too Many Requests", { "retry-after": String(Math.max(1, Math.ceil((60_000 - (now - windowAt)) / 1000))) });
    requests++;
    let body: string;
    try { body = render(); } catch { return refuse(503, "Metrics unavailable"); }
    if (Buffer.byteLength(body, "utf8") > options.outputLimit) return refuse(503, "Metrics unavailable");
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "content-length": Buffer.byteLength(body, "utf8") });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  };
}
