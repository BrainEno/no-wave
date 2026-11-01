import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * The editorial shelf (`/api/authoring/featured*`) (ADR 0016).
 *
 * Deliberately its own module: `authoring.ts` is the writing desk, where a
 * visitor's own work lives. Curating is a different act — it decides what every
 * reader is offered, not what one author wrote — and it is the only pair here
 * whose read is public and whose write is privileged.
 *
 * Nothing in this file imports a framework.
 */

function methodOf(request: Request, allowed: readonly string[]): string | null {
  const method = request.method.toUpperCase();
  return allowed.includes(method) ? method : null;
}

function rejectCrossOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host")) === false;
}

/** How many works a search for something to put on the shelf returns. */
export const FEATURED_CANDIDATES_LIMIT = 20;

/** How long a search term may be before it stops being a search term. */
const FEATURED_QUERY_MAX_LENGTH = 100;

/**
 * The shelf itself.
 *
 * `GET` is public — a reader browsing the front page asks for it, and so does
 * the editorial screen. The limit is not passed: the API's default is already
 * the shelf's own ceiling, so a screen cannot ask for more slots than exist.
 */
export function authoringFeaturedPath(locale: string = "zh-CN"): string {
  return `api/v1/featured?locale=${encodeURIComponent(locale)}`;
}

/**
 * `GET /api/authoring/featured/candidates` — published works to choose from.
 *
 * Only `published`: offering an editor a draft to put on the front page is
 * offering them a 400. The term is trimmed and capped, and everything else is
 * built here rather than forwarded, so a caller cannot widen the upstream query
 * into something the screen never meant to ask for.
 */
export function authoringFeaturedCandidatesPath(query: string, limit: number = FEATURED_CANDIDATES_LIMIT): string {
  const params = new URLSearchParams({
    status: "published",
    limit: String(limit),
    offset: "0",
  });
  const trimmed = query.trim().slice(0, FEATURED_QUERY_MAX_LENGTH);
  if (trimmed.length > 0) params.set("q", trimmed);
  return `api/v1/articles?${params.toString()}`;
}

/**
 * A whole shelf is a short list of ids — the ceiling upstream is 20 — so a
 * generous but bounded body keeps the proxy from buffering anything interesting
 * in front of an endpoint that answers 403.
 */
const FEATURED_BODY_MAX_BYTES = 8192;

/**
 * `GET`/`PUT /api/authoring/featured` — read the shelf, or replace it.
 *
 * The write is one request carrying the whole ordered list, which is why it is
 * a `PUT` and why the Origin check comes first: two editors moving different
 * works cannot be told apart from one editor re-ordering three, so the screen
 * always answers with the arrangement it believes in and the API takes it or
 * refuses it whole.
 */
export async function handleAuthoringFeaturedRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET", "PUT"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and PUT are supported for the featured shelf.", 405);
  }
  if (method === "GET") {
    return forwardAuthoringRequest(request, authoringFeaturedPath(), "GET", config);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, FEATURED_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, "api/v1/featured", "PUT", config, body.text);
}

/**
 * `GET /api/authoring/featured/candidates` — works an editor is allowed to pick.
 *
 * A read, but not a public one in spirit: it exists only to feed the editorial
 * screen, and the API answers 401 to a visitor with no session at all. The
 * proxy passes that through as an answer rather than turning it into an error
 * page, which is what lets the screen say "sign in again" instead of "broken".
 */
export async function handleAuthoringFeaturedCandidatesRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for featured candidates.", 405);
  }
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return forwardAuthoringRequest(request, authoringFeaturedCandidatesPath(query), "GET", config);
}
