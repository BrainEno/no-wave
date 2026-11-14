import { createApiContentClient, resolveApiBaseUrl } from "@/lib/api-content.ts";
import { resolveUpstreamTimeoutMs, type ApiProxyConfig } from "@bot-thk/web-http";
import { upstreamClientAddressHeaders } from "@bot-thk/web-http/client-address";

/**
 * Server-only runtime wiring.
 *
 * `resolveApiBaseUrl` comes from `@bot-thk/web-http`, so the documented
 * precedence (`API_BASE_URL`, then the transitional Vercel `API_SERVICE_URL`)
 * and the same URL validation hold here. Nothing
 * here reads a Vercel-specific binding unless that variable is explicitly set.
 */
export function apiBaseUrl(): string | undefined {
  return resolveApiBaseUrl();
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
  return createApiContentClient({ endpoint, timeoutMs: apiTimeoutMs() });
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
  return { apiBaseUrl: optionalApiBaseUrl(), upstreamTimeoutMs: process.env.API_TIMEOUT_MS, clientAddressHeaders: upstreamClientAddressHeaders };
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
  const configured = process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL;
  return configured?.trim() || "https://example.invalid";
}
