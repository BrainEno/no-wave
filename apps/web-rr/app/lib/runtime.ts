import { createApiContentClient, resolveApiBaseUrl } from "@/lib/api-content.ts";

/**
 * Server-only runtime wiring.
 *
 * `resolveApiBaseUrl` is the same function the Next.js application uses, so the
 * prototype inherits the documented precedence (`API_BASE_URL`, then the
 * transitional Vercel `API_SERVICE_URL`) and the same URL validation. Nothing
 * here reads a Vercel-specific binding unless that variable is explicitly set.
 */
export function apiBaseUrl(): string | undefined {
  return resolveApiBaseUrl();
}

export function requireContentClient() {
  const endpoint = apiBaseUrl();
  if (!endpoint) throw new Error("API_BASE_URL must be configured to read API-backed content.");
  return createApiContentClient({ endpoint });
}

/** Absolute site origin for canonical links and Open Graph URLs. */
export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://example.invalid";
}
