import type { ApiProxyConfig } from "./api.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * The view beacon's browser-facing proxy (ADR 0035).
 *
 * A view counter is only real if the page that renders the work tells the API it
 * was read, and the page cannot talk to the API directly: the session cookie is
 * scoped to this proxy, the API's own address is not the browser's, and a write
 * has to pass the same-origin check every other mutation here passes.
 *
 * Two properties are worth stating because both are easy to get wrong:
 *
 * - **`POST` only.** A view is a write. Routing a `GET` here would let a cache,
 *   a prefetch or a crawler move a counter without anyone reading anything.
 * - **No body.** The work and the locale are in the path and query; there is
 *   nothing a caller could add, so nothing has to be bounded or parsed.
 */

/** Article slugs, checked before forwarding rather than at the API. */
const VIEW_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VIEW_LOCALES = ["zh-CN", "zh-TW", "en"] as const;
const VIEW_DEFAULT_LOCALE = "zh-CN";

export function articleViewPath(slug: string, locale: string): string {
  return (
    "api/v1/articles/" + encodeURIComponent(slug) + "/views?locale=" + encodeURIComponent(locale)
  );
}

/**
 * Proxy `POST /api/articles/:slug/views`.
 *
 * Method first, then the Origin check, then the slug and locale: the order every
 * other mutation in this package uses, so a cross-origin caller cannot use the
 * status code to learn whether the slug it guessed exists.
 */
export async function handleArticleViewRequest(
  request: Request,
  params: { slug: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for a view.", 405);
  }
  if (!isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"))) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const locale = params.locale?.trim() || VIEW_DEFAULT_LOCALE;
  if (!VIEW_SLUG_PATTERN.test(params.slug) || !(VIEW_LOCALES as readonly string[]).includes(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article slug or locale.", 400);
  }
  return forwardAuthoringRequest(request, articleViewPath(params.slug, locale), "POST", config);
}
