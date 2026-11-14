import { createHash } from "node:crypto";
import { loadSitemapEntries, renderRobotsTxt, renderSitemapXml, siteOrigin, type SitemapEntry } from "../../../../packages/web-ui/src/lib/site-metadata.ts";
import { PRIVATE_PAGE_HEADERS, PUBLIC_PAGE_HEADERS } from "./http-policy.ts";
import { matchesResourceEtag } from "./resource-etag.server.ts";

type CrawlResource = "sitemap" | "robots";
export type CrawlResponseOptions = {
  siteUrl: () => string | undefined;
  loadEntries?: (siteUrl: string) => Promise<readonly SitemapEntry[]>;
};

function unavailable(request: Request, status: 405 | 503): Response {
  const headers = new Headers({ ...PRIVATE_PAGE_HEADERS, "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" });
  if (status === 405) headers.set("Allow", "GET, HEAD");
  else headers.set("Retry-After", "60");
  return new Response(request.method === "HEAD" ? null : status === 405 ? "Method not allowed.\n" : "Crawl resource temporarily unavailable.\n", { status, headers });
}

/**
 * Anonymous public resources only. Never read viewer/session state or trust the
 * request Host/forwarding headers as publication identity. There is no in-memory
 * response cache: a validator is checked against the current complete document.
 */
export async function handleCrawlRequest(request: Request, resource: CrawlResource, options: CrawlResponseOptions): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return unavailable(request, 405);
  const path = resource === "sitemap" ? "/sitemap.xml" : "/robots.txt";
  if (new URL(request.url).search) {
    return new Response(null, { status: 308, headers: { ...PUBLIC_PAGE_HEADERS, Location: path, "X-Content-Type-Options": "nosniff" } });
  }
  try {
    const origin = siteOrigin(options.siteUrl());
    let body: string;
    if (resource === "robots") body = renderRobotsTxt(origin);
    else {
      const entries = await (options.loadEntries ? options.loadEntries(origin) : loadSitemapEntries({ siteUrl: origin }));
      if (entries.some((entry) => new URL(entry.url).origin !== origin)) throw new Error("Inconsistent sitemap origin.");
      body = renderSitemapXml(entries);
    }
    const etag = `W/"${createHash("sha256").update(body).digest("hex")}"`;
    const headers = new Headers({ ...PUBLIC_PAGE_HEADERS, ETag: etag, Vary: "Accept-Encoding", "X-Content-Type-Options": "nosniff" });
    // Neither the newest article publication nor the request time is a complete
    // modification clock for directory membership. Do not invent Last-Modified.
    if (matchesResourceEtag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    headers.set("Content-Type", resource === "sitemap" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8");
    headers.set("Content-Length", String(Buffer.byteLength(body)));
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
  } catch {
    // A failed dependency or configuration must not produce cacheable HTML,
    // partial XML, a successful empty directory, a 304, or internal diagnostics.
    return unavailable(request, 503);
  }
}
