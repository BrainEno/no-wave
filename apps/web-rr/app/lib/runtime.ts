import { createApiContentClient, createPublicContentSource, resolveApiBaseUrl } from "@bot-thk/web-ui/src/lib/api-content.ts";
import { resolveUpstreamTimeoutMs, type ApiProxyConfig } from "@bot-thk/web-http";
import { upstreamClientAddressHeaders } from "@bot-thk/web-http/client-address";
import { requestRefreshCoordinator } from "@bot-thk/web-http/refresh-runtime";
import { requestUpstreamTransport } from "@bot-thk/web-http/upstream-runtime";
import { createApiSitemapSource, createFixtureSitemapSource } from "@bot-thk/web-ui/src/lib/sitemap-catalog.ts";
import { configuredSiteUrl, loadSitemapEntries } from "@bot-thk/web-ui/src/lib/site-metadata.ts";
import { isMailEnabled as resolveMailEnabled } from "@bot-thk/web-ui/src/lib/mail-feature.ts";
import { createWebUpstreamRuntime } from "../../upstream/runtime.ts";

// Native scripts may call a loader without ingress; keep their capacity bounded
// too. Normal production and Vite requests always use their ingress-owned port.
let fallbackUpstream: ReturnType<typeof createWebUpstreamRuntime> | undefined;
export function upstreamTransport() {
  const scoped = requestUpstreamTransport();
  if (scoped) return scoped;
  fallbackUpstream ??= createWebUpstreamRuntime(process.env);
  return fallbackUpstream.transport;
}

/**
 * Server-only runtime wiring.
 *
 * `resolveApiBaseUrl` is a pure shared UI resolver, so the documented
 * precedence (`API_BASE_URL`, legacy `API_GRAPHQL_URL`, then `API_SERVICE_URL`)
 * and the same URL validation hold here. Nothing
 * here reads a Vercel-specific binding unless that variable is explicitly set.
 */
export function apiBaseUrl(): string | undefined {
  return resolveApiBaseUrl({ explicitUrl: process.env.API_BASE_URL,
    serviceUrl: process.env.API_SERVICE_URL, legacyGraphqlUrl: process.env.API_GRAPHQL_URL });
}

/**
 * The API origin, or `undefined` when none is configured — or when the
 * configured value is invalid. A malformed value is a deployment error, but it
 * must surface as the route's own 503, not as an unhandled exception in a
 * resource route.
 */
export function optionalApiBaseUrl(): string | undefined {
  try {
    return apiBaseUrl();
  } catch {
    return undefined;
  }
}

/**
 * Upstream budget for every API call this process makes (audit F-17).
 *
 * `API_TIMEOUT_MS` overrides the default. Values are validated by
 * `resolveUpstreamTimeoutMs`, which throws on anything that is not a whole
 * number of milliseconds in range: a typo must never silently become an
 * unbounded wait. The thrown error surfaces as the route's own 503 (public
 * pages) or as its "not configured correctly" 503 (proxies).
 */
export function apiTimeoutMs(): number {
  return resolveUpstreamTimeoutMs(process.env.API_TIMEOUT_MS);
}

export function requireContentClient() {
  const endpoint = apiBaseUrl();
  if (!endpoint) throw new Error("API_BASE_URL must be configured to read API-backed content.");
  return createApiContentClient({ endpoint, timeoutMs: apiTimeoutMs(), upstreamTransport: upstreamTransport() });
}

/**
 * Config for one proxied API call: origin plus the bounded budget.
 *
 * Every adapter goes through this, so a route added later cannot quietly call
 * the API without a deadline. The raw value is passed through rather than
 * resolved here: each handler validates it before calling the API and answers a
 * malformed one with its own "not configured correctly" 503, so the rejection
 * happens in one place instead of two.
 */
export function apiProxyConfig(): ApiProxyConfig {
  return { apiBaseUrl: optionalApiBaseUrl(), upstreamTimeoutMs: process.env.API_TIMEOUT_MS, clientAddressHeaders: upstreamClientAddressHeaders, refreshCoordinator: requestRefreshCoordinator(), upstreamTransport: upstreamTransport() };
}

/**
 * Absolute site origin for canonical links and Open Graph URLs.
 *
 * `SITE_URL` is the name; `NEXT_PUBLIC_SITE_URL` is the one the App Router
 * needed, and it is still read because deployments hold it in a dashboard this
 * repository cannot edit — a rename that silently emptied every canonical URL
 * would be worse than a name that carries a dead framework's prefix. New
 * deployments should use `SITE_URL` (ADR 0017 retired Next.js).
 *
 * Neither is inlined at build time here: the value is read per request, so
 * changing it needs a restart, not a rebuild.
 */
export function siteUrl(): string {
  return configuredSiteUrl({ siteUrl: process.env.SITE_URL, legacySiteUrl: process.env.NEXT_PUBLIC_SITE_URL });
}

/** No ambient configuration in the shared UI, and no mutable global content client. */
export function publicContentSource(request?: Request) {
  const endpoint = apiBaseUrl();
  return createPublicContentSource(endpoint ? createApiContentClient({ endpoint, timeoutMs: apiTimeoutMs(),
    upstreamTransport: upstreamTransport(), signal: request?.signal }) : null);
}

export function publicTagSource(request?: Request) {
  const source = publicContentSource(request);
  return { listTags: source.listPublicTags, getTag: source.getPublicTag, listArticles: source.listPublicTagArticles };
}

export function publicSitemapSource(request?: Request) {
  const endpoint = apiBaseUrl();
  return endpoint ? createApiSitemapSource({ endpoint, timeoutMs: apiTimeoutMs(), upstreamTransport: upstreamTransport(), signal: request?.signal }) : createFixtureSitemapSource();
}

export function loadPublicSitemap(siteUrl: string, request?: Request) {
  return loadSitemapEntries({ siteUrl, source: publicSitemapSource(request), signal: request?.signal });
}

export function mailEnabled(): boolean {
  return resolveMailEnabled({ MAIL_ENABLED: process.env.MAIL_ENABLED });
}
