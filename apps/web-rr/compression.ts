import compression from "compression";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Add a cache-key dimension without losing the framework's existing Vary. */
function addVary(response: ServerResponse, ...fields: string[]): void {
  const existing = response.getHeader("Vary");
  const values = (Array.isArray(existing) ? existing.join(",") : String(existing ?? ""))
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (values.includes("*")) return;
  for (const field of fields) {
    if (!values.some((value) => value.toLowerCase() === field.toLowerCase())) values.push(field);
  }
  response.setHeader("Vary", values.join(", "));
}

/**
 * Only public, cookie-free, query-free HTML and the build's JS/CSS are eligible.
 * Never compress credentials, private responses, API responses, redirects or
 * reflected query strings alongside secrets (compression side channels).
 * Eligibility is decided at header time, after the route sets its cache policy.
 */
const middleware = compression({
  threshold: 1024,
  filter(request, response) {
    const type = String(response.getHeader("Content-Type") ?? "").toLowerCase();
    const cache = String(response.getHeader("Cache-Control") ?? "").toLowerCase();
    const target = request.url ?? "/";
    const pathname = target.split("?", 1)[0] ?? "/";
    const html = /^text\/html(?:;|$)/.test(type);
    const asset = /^\/assets\//.test(pathname) && /\.(?:m?js|css)$/.test(pathname) &&
      /^(?:text\/(?:javascript|css)|application\/(?:javascript|x-javascript))(?:;|$)/.test(type);

    // Both eligible and ineligible variants need consistent cache dimensions.
    // Framework `Vary` values (e.g. React Router's request headers) are retained.
    if (html) addVary(response, "Accept-Encoding", "Cookie", "Authorization");
    else if (asset) addVary(response, "Accept-Encoding");

    if (response.statusCode !== 200 || response.hasHeader("Set-Cookie")) return false;
    if (/\b(?:private|no-store|no-transform)\b/.test(cache)) return false;
    if (asset) return compression.filter(request, response);
    if (!html || !/(?:^|,)\s*public(?:\s*,|$)/.test(cache)) return false;
    if (target.includes("?") || request.headers.cookie || request.headers.authorization) return false;
    return compression.filter(request, response);
  },
});

// compression operates on Node's request/response primitives; its published
// types are Express-specific, although no Express application is involved.
export const compressResponse = middleware as unknown as (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;
