import type { ApiProxyConfig } from "./api.ts";
import { errorResponse } from "./http.ts";
import { forwardAuthoringRequest } from "./forward.ts";

/**
 * 关注流 — the browser-facing proxy for the following feed (#198).
 *
 * `GET /api/v1/me/feed` is the reason `users.follow` exists: without it,
 * following an author only lets a reader walk into that profile and look, and
 * the graph is write-only. The endpoint has been served for a while with no Web
 * surface calling it.
 *
 * This is a read, so unlike the follow and like proxies it has no Origin check:
 * a GET cannot change anything, and a cross-origin page cannot read the answer
 * anyway (same-origin policy, and this response carries `no-store`).
 *
 * It **does** require a session, and the API enforces that. The proxy does not
 * repeat the check — a proxy that guesses at auth is a second place for auth to
 * be wrong — but it also must not soften the answer: a signed-out caller gets
 * the API's `401`, which is what tells the page to show "sign in to see your
 * feed" rather than an empty feed that looks like nobody the reader follows has
 * published anything. Those two states are very different and only the status
 * code distinguishes them.
 *
 * Nothing in this file imports a framework.
 */

/** Locales the feed is read in. */
export const FEED_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export const FEED_DEFAULT_LOCALE = "zh-CN";

/**
 * Bounds, mirroring the API's own (`parsePagination(url, 20, MAX_ARTICLE_OFFSET)`).
 *
 * Checked here as well because a proxy that forwards `limit=abc` turns a client
 * bug into an API `400` that the reader sees as a broken page. Refusing it at
 * the edge names the actual problem and costs one comparison.
 */
export const FEED_DEFAULT_LIMIT = 20;
export const FEED_MAX_LIMIT = 100;
export const FEED_MAX_OFFSET = 10_000;

export function isFeedLocale(locale: string): boolean {
  return FEED_LOCALES.includes(locale);
}

/**
 * Parse a positive-integer query value within bounds.
 *
 * Returns `null` for anything that is not a clean decimal integer, so `1.5`,
 * `1e3`, `+1`, ` 1` and `abc` are all refused rather than coerced. `Number()`
 * would accept every one of them and mean something the caller did not ask for.
 */
export function parseFeedInteger(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) return null;
  return value;
}

export function feedRequestPath(locale: string, limit: number, offset: number): string {
  return (
    "api/v1/me/feed?locale=" +
    encodeURIComponent(locale) +
    "&limit=" +
    limit +
    "&offset=" +
    offset
  );
}

/**
 * Proxy `GET /api/feed`.
 *
 * `offset` is allowed to be `0`; `limit` is not, because a feed with a limit of
 * zero is a request for nothing and almost certainly a caller bug.
 */
export async function handleFeedRequest(
  request: Request,
  params: { locale?: string | null; limit?: string | null; offset?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for the feed.", 405);
  }

  const locale = params.locale?.trim() || FEED_DEFAULT_LOCALE;
  const limit = parseFeedInteger(params.limit ?? null, FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
  const offset = parseFeedInteger(params.offset ?? null, 0, FEED_MAX_OFFSET);
  if (!isFeedLocale(locale) || limit === null || limit < 1 || offset === null) {
    return errorResponse("BAD_USER_INPUT", "Invalid locale, limit, or offset query parameter.", 400);
  }

  return forwardAuthoringRequest(request, feedRequestPath(locale, limit, offset), "GET", config);
}
