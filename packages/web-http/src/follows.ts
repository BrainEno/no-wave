import type { ApiProxyConfig } from "./api.ts";
import { errorResponse } from "./http.ts";
import { forwardAuthoringRequest, forwardViewerRead } from "./forward.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * 关注作者 — the browser-facing proxy for a reader's follow state (#198).
 *
 * The API has served `POST`/`DELETE /api/v1/users/:userId/follow` for a while
 * and, like the like endpoint before it, no Web surface called it. This is the
 * missing seam, written the way the other proxies are written: the same checks
 * in the same order, shared by every framework adapter.
 *
 * The API models this as a **relationship**, not a boolean, so the proxy speaks
 * `POST` and `DELETE` rather than inventing a `PUT {following: true}`. A
 * translation layer that flattened it into one would be a second definition of
 * the operation, free to drift from the one the API actually implements — and
 * `docs/architecture/rest-idempotency.md` already records both verbs as
 * convergent, so there is nothing for a key or a wrapper to fix.
 *
 * Both verbs require a session. The API decides that and this proxy does not
 * repeat it: a proxy that guesses at auth is a second place for auth to be
 * wrong. What the proxy does enforce is that a cross-origin caller never learns
 * whether the id it guessed exists.
 *
 * Nothing in this file imports a framework.
 */

/**
 * A target user id, as the public author page addresses it.
 *
 * Deliberately **not** a UUID pattern, although the accounts this instance
 * registers today are UUIDs. The id here is whatever the author page carries,
 * and the author page's identifier is the `userId` the API returned — an
 * instance that seeded its accounts, or migrated them, may have ids that are
 * not UUIDs, and `decodeUserId` on the API side accepts anything short and
 * well-formed. Rejecting those here would break the follow button on those
 * instances while the API underneath was perfectly willing to answer.
 *
 * What is rejected is what cannot be a path segment or could not survive a
 * round trip: empty, whitespace-padded, over-long, or containing a slash or a
 * control character. That is a transport question, which is the proxy's
 * business; the identity question is the API's.
 */
export const FOLLOW_TARGET_MAX_LENGTH = 300;

/**
 * Chosen to match the API's own bound. `/` is excluded because the id becomes a
 * path segment, and the rest is the C0 control range plus DEL — characters that
 * either cannot appear in a URL or mean something else once decoded.
 */
const FORBIDDEN_IN_TARGET = /[/\\\u0000-\u001F\u007F]/;

export function isFollowTargetId(value: string): boolean {
  if (value.length === 0 || value.length > FOLLOW_TARGET_MAX_LENGTH) return false;
  if (value.trim() !== value) return false;
  if (FORBIDDEN_IN_TARGET.test(value)) return false;
  // `.` and `..` would be resolved by any intermediary that normalises paths
  // before this function ever sees them, so they are refused rather than
  // forwarded as a surprise 404.
  return value !== "." && value !== "..";
}

/** Locales a follow is recorded against; the API requires one on every verb. */
export const FOLLOW_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export const FOLLOW_DEFAULT_LOCALE = "zh-CN";

export function isFollowLocale(locale: string): boolean {
  return FOLLOW_LOCALES.includes(locale);
}

export function followRequestPath(targetUserId: string, locale: string): string {
  return (
    "api/v1/users/" +
    encodeURIComponent(targetUserId) +
    "/follow?locale=" +
    encodeURIComponent(locale)
  );
}

/**
 * Proxy `POST`/`DELETE /api/users/:userId/follow`.
 *
 * The Origin check precedes validation, so a cross-origin request never learns
 * whether the id it guessed was well-formed — the same reason every other
 * mutation proxy in this package does it in that order.
 *
 * There is no `GET`: the API has none, and the viewer's own follow state arrives
 * on `GET /api/v1/authors/:userId` as `isFollowing`. Inventing a read endpoint
 * here would mean the proxy holding a second answer to a question the API
 * already answers.
 */
export async function handleUserFollowRequest(
  request: Request,
  params: { targetUserId: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method =
    request.method === "POST" ? "POST" : request.method === "DELETE" ? "DELETE" : null;
  if (method === null) {
    return errorResponse(
      "METHOD_NOT_ALLOWED",
      "Only POST and DELETE are supported for follows.",
      405,
    );
  }

  const sameOrigin = isSameOriginMutation(
    request.url,
    request.headers.get("origin"),
    request.headers.get("host"),
    request.headers.get("x-forwarded-proto"),
  );
  if (!sameOrigin) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }

  const locale = params.locale?.trim() || FOLLOW_DEFAULT_LOCALE;
  if (!isFollowTargetId(params.targetUserId) || !isFollowLocale(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid target user ID or locale.", 400);
  }

  // No body: the verb *is* the state. Sending one would suggest the payload
  // carries meaning the API does not read.
  return forwardAuthoringRequest(
    request,
    followRequestPath(params.targetUserId, locale),
    method,
    config,
  );
}

/**
 * `GET /api/authors/:userId` — the author profile, including the viewer's own
 * follow state.
 *
 * This exists because of a fact about the author page that is easy to miss: it
 * is server-rendered from an API call that carries no session, so `isFollowing`
 * arrives as `false` for everybody, including a reader who follows the author.
 * The count is public and correct either way; the boolean cannot be known until
 * the browser asks with its own cookie.
 *
 * The API already answers the question at `GET /api/v1/authors/:userId`, so this
 * is a read proxy and nothing more. It deliberately does **not** invent
 * `GET /users/:id/follow`: that endpoint answers 405, and a second read of the
 * same fact is a second answer that can disagree with the first.
 *
 * A signed-out read is still forwarded — the profile is public, and the API
 * returns `isFollowing: false` rather than an error, which is exactly what the
 * page should show.
 */
export async function handleAuthorProfileRequest(
  request: Request,
  params: { userId: string; locale?: string | null },
  config: ApiProxyConfig = {},
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for author profiles.", 405);
  }

  const locale = params.locale?.trim() || FOLLOW_DEFAULT_LOCALE;
  if (!isFollowTargetId(params.userId) || !isFollowLocale(locale)) {
    return errorResponse("BAD_USER_INPUT", "Invalid author user ID or locale.", 400);
  }

  return forwardViewerRead(
    request,
    "api/v1/authors/" + encodeURIComponent(params.userId) + "?locale=" + encodeURIComponent(locale),
    config,
  );
}
