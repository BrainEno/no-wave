import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * The writing desk's browser-facing proxy (ADR 0012, Phase 4b).
 *
 * `AuthoringWorkspace` is a shared client component: it asks for the session,
 * lists the author's articles, creates one, updates one, deletes one, lists the
 * deleted ones and restores one. Those calls are what make the desk
 * interactive, and until this module existed they were only served by the App
 * Router — the same failure the comment section had in Phase 4a, where a page
 * rendered correctly and had nothing to talk to.
 *
 * The behaviour is shared rather than re-implemented per framework: the
 * exact-Origin check on mutations, the article-id shape check, the bounded body,
 * cookie-attached forwarding with refresh-and-retry and the no-store policy all
 * live here, and each framework contributes only a route adapter.
 *
 * Nothing in this file imports a framework.
 */

/** Article ids are UUIDs; the shape is checked before proxying. */
export const AUTHORING_ARTICLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * An article body carries the whole Lexical document, so the ceiling is
 * generous — it is the value the App Router already used, kept identical so the
 * extraction changes no observable behaviour.
 */
export const AUTHORING_BODY_MAX_BYTES = 2_000_000;

/** The desk lists at most this many works; the API paginates the rest. */
export const AUTHORING_ARTICLES_LIMIT = 100;

export const AUTHORING_DEFAULT_LOCALE = "zh-CN";

export const AUTHORING_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export function isAuthoringLocale(locale: string): boolean {
  return AUTHORING_LOCALES.includes(locale);
}

export function authoringArticlesPath(
  locale: string = AUTHORING_DEFAULT_LOCALE,
  limit: number = AUTHORING_ARTICLES_LIMIT,
): string {
  return `api/v1/me/articles?locale=${encodeURIComponent(locale)}&limit=${encodeURIComponent(String(limit))}`;
}

export function authoringArticlePath(id: string): string {
  return `api/v1/articles/${encodeURIComponent(id)}`;
}

/** The desk's recycle bin: the author's own tombstones. */
export function authoringDeletedArticlesPath(
  locale: string = AUTHORING_DEFAULT_LOCALE,
  limit: number = AUTHORING_ARTICLES_LIMIT,
): string {
  return `api/v1/me/articles/deleted?locale=${encodeURIComponent(locale)}&limit=${encodeURIComponent(String(limit))}`;
}

export function authoringRestoreArticlePath(id: string): string {
  return `api/v1/articles/${encodeURIComponent(id)}/restore`;
}

function methodOf(request: Request, allowed: readonly string[]): string | null {
  const method = request.method.toUpperCase();
  return allowed.includes(method) ? method : null;
}

function rejectCrossOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host")) === false;
}

/**
 * `GET /api/authoring/session` — who is signed in, if anyone.
 *
 * A 401 is an answer, not an error: the workspace renders its "sign in first"
 * panel from it. The refresh-and-retry and the cookie clearing on a rejected
 * refresh token are `forwardAuthoringRequest`'s job.
 */
export async function handleAuthoringSessionRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for the session.", 405);
  }
  return forwardAuthoringRequest(request, "api/v1/me", "GET", config);
}

/**
 * `GET`/`POST /api/authoring/articles` — the author's list, and a new work.
 *
 * The Origin check precedes everything else on the write, so a cross-origin
 * request never learns what the endpoint accepts.
 */
export async function handleAuthoringArticlesRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET", "POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and POST are supported for articles.", 405);
  }
  if (method === "GET") {
    return forwardAuthoringRequest(request, authoringArticlesPath(), "GET", config);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, AUTHORING_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, "api/v1/articles", "POST", config, body.text);
}

/**
 * `PUT /api/authoring/articles/:id` — save or publish an existing work.
 * `DELETE /api/authoring/articles/:id` — delete it.
 *
 * Order matters and is the App Router's order: the method is checked first, then
 * the Origin, then the id, so a cross-origin caller cannot use the status code to
 * probe which article ids exist, and a DELETE is refused for its origin before
 * anything looks at the work it names.
 *
 * DELETE carries no body, so it is forwarded without the body ceiling a save is
 * subject to.
 */
export async function handleAuthoringArticleRequest(
  request: Request,
  params: { id: string },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["PUT", "DELETE"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only PUT and DELETE are supported for an article.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  if (!AUTHORING_ARTICLE_ID_PATTERN.test(params.id)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article ID.", 400);
  }
  if (method === "DELETE") {
    return forwardAuthoringRequest(request, authoringArticlePath(params.id), "DELETE", config);
  }
  const body = await readLimitedJson(request, AUTHORING_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, authoringArticlePath(params.id), "PUT", config, body.text);
}

/**
 * `GET /api/authoring/deleted-articles` — the author's own deleted works.
 *
 * The list that makes a soft delete recoverable: without it, a deleted work is
 * invisible, which is the one thing an author cannot tell apart from a bug. It
 * is a read, so it needs no Origin check; the API still answers 401 without a
 * session, which is how the workspace decides to show the sign-in panel.
 */
export async function handleAuthoringDeletedArticlesRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for deleted articles.", 405);
  }
  return forwardAuthoringRequest(request, authoringDeletedArticlesPath(), "GET", config);
}

/**
 * `POST /api/authoring/articles/:id/restore` — bring a deleted work back.
 *
 * The same order as a save and a delete: the method first, then the Origin, then
 * the id, so a cross-origin caller cannot use the status code to probe which ids
 * exist. Restoring carries no body — it addresses a work the author already has
 * — so it is forwarded without the body ceiling a save is subject to.
 */
export async function handleAuthoringRestoreRequest(
  request: Request,
  params: { id: string },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for restoring an article.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  if (!AUTHORING_ARTICLE_ID_PATTERN.test(params.id)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article ID.", 400);
  }
  return forwardAuthoringRequest(request, authoringRestoreArticlePath(params.id), "POST", config);
}
