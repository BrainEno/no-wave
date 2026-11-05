import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { errorResponse } from "./http.ts";
import { forwardAuthoringRequest, forwardViewerRead } from "./forward.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * 收藏作品 — the browser-facing proxy for a reader's like state (#198).
 *
 * The API has served `GET`/`PUT /api/v1/articles/:slug/like` for a while, and
 * nothing in the Web app called it: `ArticlePageView` had no interaction at all,
 * so the capability existed only for clients that already knew about it. This is
 * the missing seam, written the way the comment proxy is written — the same
 * checks in the same order, shared by every framework adapter, so the two
 * frameworks cannot disagree about what a like request is.
 *
 * `GET` carries the viewer when there is one and answers `likedByViewer: false`
 * when there is not: the page is readable signed out, and the count is public.
 * `PUT` requires a session, which the API enforces — this proxy does not need to
 * duplicate that, and must not, because a proxy that guesses at auth is a second
 * place for auth to be wrong.
 *
 * Nothing in this file imports a framework.
 */

/** Article slugs are lowercase kebab-case; the shape is checked before proxying. */
export const LIKE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Locales a like is recorded against. */
export const LIKE_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export const LIKE_DEFAULT_LOCALE = "zh-CN";

/**
 * The body is one boolean.
 *
 * Bounded generously relative to its content because the limit is about refusing
 * an unbounded read, not about being tight: a 1 KiB ceiling on `{"liked":true}`
 * still leaves room for any reasonable client's whitespace.
 */
export const LIKE_BODY_MAX_BYTES = 1024;

export function isLikeLocale(locale: string): boolean {
  return LIKE_LOCALES.includes(locale);
}

export function likeRequestPath(slug: string, locale: string): string {
  return (
    "api/v1/articles/" +
    encodeURIComponent(slug) +
    "/like?locale=" +
    encodeURIComponent(locale)
  );
}

/**
 * Pull `liked` out of a request body.
 *
 * Deliberately strict: only a real boolean counts. The API rejects anything else
 * as `BAD_USER_INPUT`, and forwarding `"true"` or `1` would mean the proxy and
 * the API disagree about what a valid request is — the client would then see a
 * different error depending on which layer noticed first.
 */
export function parseLikeBody(value: unknown): { ok: true; liked: boolean } | { ok: false } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
  const liked = (value as { liked?: unknown }).liked;
  return typeof liked === "boolean" ? { ok: true, liked } : { ok: false };
}

/**
 * Proxy `GET`/`PUT /api/articles/:slug/like`.
 *
 * The check order matches the comment proxy: the Origin check precedes
 * validation on mutations, so a cross-origin request never learns whether the
 * slug it guessed was valid.
 */
export async function handleArticleLikeRequest(
  request: Request,
  params: { slug: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = request.method === "GET" ? "GET" : request.method === "PUT" ? "PUT" : null;
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and PUT are supported for likes.", 405);
  }

  if (method === "PUT") {
    const sameOrigin = isSameOriginMutation(
      request.url,
      request.headers.get("origin"),
      request.headers.get("host"),
      request.headers.get("x-forwarded-proto"),
    );
    if (!sameOrigin) {
      return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
    }
  }

  const locale = params.locale?.trim() || LIKE_DEFAULT_LOCALE;
  if (!LIKE_SLUG_PATTERN.test(params.slug) || !isLikeLocale(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article slug or locale.", 400);
  }

  const path = likeRequestPath(params.slug, locale);
  if (method === "GET") return forwardViewerRead(request, path, config);

  const body = await readLimitedJson(request, LIKE_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return errorResponse("BAD_USER_INPUT", "The request body must be JSON.", 400);
  }
  const like = parseLikeBody(parsed);
  if (!like.ok) {
    return errorResponse("BAD_USER_INPUT", "liked must be true or false.", 400);
  }
  // Re-serialised rather than passed through: the client's whitespace and key
  // order are not part of the request, and forwarding them verbatim would make
  // two identical intents look different to anything downstream that hashes it.
  return forwardAuthoringRequest(request, path, "PUT", config, JSON.stringify({ liked: like.liked }));
}
