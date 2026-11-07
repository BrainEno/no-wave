import { defaultLocale, type Locale } from "@/lib/content.ts";

/**
 * Locale comes from the request path, which is the only place it is decided.
 *
 * English is a differently-named directory (`/en/...` vs `/...`); an explicit
 * function keeps that mapping in one line
 * instead of scattering string tests over every route module.
 */
export function localeFor(url: URL): Locale {
  // React Router's `url`, not `new URL(request.url)`: with the v8 request
  // pass-through, `request.url` keeps the `.data` suffix and internal search
  // parameters, so the English home's data request would arrive as `/en.data`
  // and fail a `/en` prefix test. `url` is the framework's normalized view.
  return /^\/en(\/|$)/.test(url.pathname) ? "en" : defaultLocale;
}
