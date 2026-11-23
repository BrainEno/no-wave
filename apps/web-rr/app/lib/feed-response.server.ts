import { createHash } from "node:crypto";
import { PRIVATE_PAGE_HEADERS, PUBLIC_PAGE_HEADERS } from "./http-policy.ts";
import { matchesResourceEtag } from "./resource-etag.server.ts";

/** What a feed renderer hands back; see `renderArticleFeed`. */
export type RenderedFeed = { body: string; contentType: string; self: string; alternate: string };

/**
 * A failure is private and uncached: a 404 or 503 must never be stored by a
 * shared cache as if it were the feed, and its body is a fixed sentence — no
 * upstream text, credential or diagnostic ever reaches a feed reader.
 */
export function feedFailure(request: Request, status: 404 | 405 | 503, noun: string): Response {
  const headers = new Headers({ ...PRIVATE_PAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" });
  if (status === 405) headers.set("Allow", "GET, HEAD");
  if (status === 503) headers.set("Retry-After", "60");
  const message = status === 404 ? `${noun} not found.\n` : status === 405 ? "Method not allowed.\n" : `${noun} temporarily unavailable.\n`;
  return new Response(request.method === "HEAD" ? null : message, { status, headers });
}

/**
 * The HTTP contract every public feed shares (tag feeds, the site feed).
 *
 * No viewer/session read and no process-local cache: the anonymous API owns
 * visibility. `render` returns `null` for "no such feed" (404) and throws for
 * anything else (503).
 */
export async function respondWithFeed(request: Request, options: { noun: string; canonicalPath: string; render: () => Promise<RenderedFeed | null> }): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return feedFailure(request, 405, options.noun);
  // Feeds have one latest-page representation. Never turn ignored query strings
  // into an infinite shared-cache key space or an alternate pagination contract.
  if (new URL(request.url).search) {
    return new Response(null, { status: 308, headers: { ...PUBLIC_PAGE_HEADERS,
      Location: options.canonicalPath, "X-Robots-Tag": "noindex, follow" } });
  }
  try {
    const rendered = await options.render();
    if (!rendered) return feedFailure(request, 404, options.noun);
    // Compression can change wire bytes; this is deliberately a weak validator
    // over the complete XML, including renames, summary edits and locale URLs.
    const etag = `W/"${createHash("sha256").update(rendered.body).digest("hex")}"`;
    const headers = new Headers({ ...PUBLIC_PAGE_HEADERS, ETag: etag, Vary: "Accept-Encoding",
      "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, follow",
      Link: `<${rendered.self}>; rel="self"; type="${rendered.contentType.split(";")[0]}", <${rendered.alternate}>; rel="alternate"; type="text/html"` });
    // Do not invent Last-Modified from publication time: that would miss edits,
    // removed articles and renames. Only the full representation is known.
    if (matchesResourceEtag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    headers.set("Content-Type", rendered.contentType);
    headers.set("Content-Length", String(Buffer.byteLength(rendered.body)));
    return new Response(request.method === "HEAD" ? null : rendered.body, { status: 200, headers });
  } catch {
    // Upstream bodies, credentials and internal diagnostics never become XML,
    // hydration payloads, response headers or a cacheable successful empty feed.
    return feedFailure(request, 503, options.noun);
  }
}
