import { defaultLocale, type Locale } from "@/lib/content.ts";

/**
 * Locale comes from the request path, which is the only place it is decided.
 *
 * The App Router encoded the same information in a differently-named directory
 * (`/en/...` vs `/...`); an explicit function keeps that mapping in one line
 * instead of scattering string tests over every route module.
 */
export function localeFor(request: Request): Locale {
  const pathname = new URL(request.url).pathname;
  return /^\/en(\/|$)/.test(pathname) ? "en" : defaultLocale;
}
