import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { errorResponse } from "./http.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * Article comments — the browser-facing proxy for a migrated public page's only
 * interactive, state-changing surface (ADR 0012, Phase 4a).
 *
 * `ArticleComments` is a shared client component: the App Router and the React
 * Router prototype render the same markup, so hydration works in both. What did
 * **not** exist in the prototype was the endpoint the component calls, which made
 * the comment section dead on arrival — a page can render perfectly and still be
 * broken after hydration. The behaviour below is therefore shared rather than
 * re-implemented per framework: slug/locale validation, the exact-Origin check on
 * mutations, a bounded body, cookie-attached forwarding and error sanitization
 * all live here, and each framework contributes only a route adapter.
 *
 * Nothing in this file imports a framework.
 */

/** Article slugs are lowercase kebab-case; the shape is checked before proxying. */
export const COMMENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Locales the comment thread is served in. */
export const COMMENT_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export const COMMENT_DEFAULT_LOCALE = "zh-CN";

/** A comment body is short; 512 KiB is generous and still bounded. */
export const COMMENT_BODY_MAX_BYTES = 512 * 1024;

/** The thread is capped server-side so a popular article cannot balloon the payload. */
export const COMMENT_PAGE_LIMIT = 50;

export function isCommentLocale(locale: string): boolean {
  return COMMENT_LOCALES.includes(locale);
}

export function commentsRequestPath(slug: string, locale: string): string {
  return (
    "api/v1/articles/" +
    encodeURIComponent(slug) +
    "/comments?locale=" +
    encodeURIComponent(locale) +
    "&limit=" +
    COMMENT_PAGE_LIMIT
  );
}

/**
 * Proxy `GET`/`POST /api/articles/:slug/comments`.
 *
 * The order of the checks is the App Router's order and is not cosmetic: the
 * Origin check precedes validation on mutations, so a cross-origin request never
 * learns whether the slug it guessed was valid.
 */
export async function handleArticleCommentsRequest(
  request: Request,
  params: { slug: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = request.method === "GET" ? "GET" : request.method === "POST" ? "POST" : null;
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and POST are supported for comments.", 405);
  }

  if (method === "POST") {
    const sameOrigin = isSameOriginMutation(
      request.url,
      request.headers.get("origin"),
      request.headers.get("host"),
    );
    if (!sameOrigin) {
      return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
    }
  }

  const locale = params.locale?.trim() || COMMENT_DEFAULT_LOCALE;
  if (!COMMENT_SLUG_PATTERN.test(params.slug) || !isCommentLocale(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article slug or locale.", 400);
  }

  const path = commentsRequestPath(params.slug, locale);
  if (method === "GET") {
    return forwardAuthoringRequest(request, path, "GET", config);
  }

  const body = await readLimitedJson(request, COMMENT_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, path, "POST", config, body.text);
}
