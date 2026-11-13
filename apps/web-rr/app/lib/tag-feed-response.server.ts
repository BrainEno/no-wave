import { createHash } from "node:crypto";
import type { Locale } from "../../../../packages/web-ui/src/lib/content.ts";
import { isTagSlug } from "../../../../packages/web-ui/src/lib/tag-discovery.ts";
import { loadTagDetailPage, type TagPageSource } from "../../../../packages/web-ui/src/lib/tag-pages.ts";
import { parseTagFeedFormat, renderTagFeed, tagFeedPath } from "../../../../packages/web-ui/src/lib/tag-feed.ts";
import { PRIVATE_PAGE_HEADERS, PUBLIC_PAGE_HEADERS } from "./http-policy.ts";

type FeedOptions = { slug?: string; format?: string; locale: Locale; siteUrl: string };

/** GET/HEAD use weak comparison, but a malformed whole field is not a valid match. */
export function matchesFeedEtag(value: string | null, expected: string): boolean {
  if (!value || value.length > 8192) return false;
  const field = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (field === "*") return true;
  const token = /[ \t]*(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[ \t]*(,|$)/y;
  const target = expected.replace(/^W\//, "");
  let matched = false;
  let index = 0;
  while (index < field.length) {
    token.lastIndex = index;
    const part = token.exec(field);
    if (!part || token.lastIndex <= index || (part[2] === "," && token.lastIndex === field.length)) return false;
    matched ||= part[1] === target;
    index = token.lastIndex;
  }
  return matched;
}

function failure(request: Request, status: number): Response {
  const headers = new Headers({ ...PRIVATE_PAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" });
  if (status === 405) headers.set("Allow", "GET, HEAD");
  if (status === 503) headers.set("Retry-After", "60");
  const message = status === 404 ? "Tag feed not found.\n" : status === 405 ? "Method not allowed.\n" : "Tag feed temporarily unavailable.\n";
  return new Response(request.method === "HEAD" ? null : message, { status, headers });
}

/** No viewer/session read and no process-local cache. The anonymous API owns visibility. */
export async function handleTagFeedRequest(request: Request, options: FeedOptions, source?: TagPageSource): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return failure(request, 405);
  const format = parseTagFeedFormat(options.format);
  if (!isTagSlug(options.slug) || !format) return failure(request, 404);
  // Feeds have one latest-page representation. Never turn ignored query strings
  // into an infinite shared-cache key space or an alternate pagination contract.
  if (new URL(request.url).search) {
    return new Response(null, { status: 308, headers: { ...PUBLIC_PAGE_HEADERS,
      Location: tagFeedPath(options.slug, options.locale, format), "X-Robots-Tag": "noindex, follow" } });
  }
  try {
    const loaded = await loadTagDetailPage({ locale: options.locale, slug: options.slug, page: 1 }, source);
    if (!loaded.tag) return failure(request, 404);
    const rendered = renderTagFeed({ ...loaded, tag: loaded.tag, siteUrl: options.siteUrl, format });
    // Compression can change wire bytes; this is deliberately a weak validator
    // over the complete XML, including renames, summary edits and locale URLs.
    const etag = `W/"${createHash("sha256").update(rendered.body).digest("hex")}"`;
    const headers = new Headers({ ...PUBLIC_PAGE_HEADERS, ETag: etag, Vary: "Accept-Encoding",
      "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, follow",
      Link: `<${rendered.self}>; rel="self"; type="${rendered.contentType.split(";")[0]}", <${rendered.alternate}>; rel="alternate"; type="text/html"` });
    // Do not invent Last-Modified from publication time: that would miss edits,
    // removed articles and tag renames. Only the full representation is known.
    if (matchesFeedEtag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    headers.set("Content-Type", rendered.contentType);
    headers.set("Content-Length", String(Buffer.byteLength(rendered.body)));
    return new Response(request.method === "HEAD" ? null : rendered.body, { status: 200, headers });
  } catch {
    // Upstream bodies, credentials and internal diagnostics never become XML,
    // hydration payloads, response headers or a cacheable successful empty feed.
    return failure(request, 503);
  }
}
