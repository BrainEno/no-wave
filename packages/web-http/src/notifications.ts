import type { ApiProxyConfig } from "./api.ts";
import { forwardAuthoringRequest, type ForwardMethod } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * The notification inbox's browser-facing proxy.
 *
 * The inbox exists because deleting a work eventually deletes the comments
 * under it, and those are other people's words: the API writes each commenter a
 * notice naming the date the sweep runs, but a notice nobody can read is a
 * ledger entry, not a message. This module is what makes it readable.
 *
 * Reads (the list and the unread count) are plain GETs. Writes — marking one or
 * all of them read — are mutations like any other: an exact Origin match, and
 * the notification id shape-checked before it is forwarded, so a cross-origin
 * caller cannot use the status code to probe which notification ids exist.
 *
 * Nothing in this file imports a framework.
 */

/** Notification ids are UUIDs; the shape is checked before proxying. */
export const NOTIFICATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An optional restriction on a server-verified account, never authentication. */
export const NOTIFICATION_EXPECTED_ACTOR_HEADER = "x-expected-notification-actor";

function expectedNotificationActor(request: Request): { actorId?: string; response?: Response } {
  const raw = request.headers.get(NOTIFICATION_EXPECTED_ACTOR_HEADER);
  if (raw === null) return {};
  const invalid = () => ({ response: errorResponse("BAD_USER_INPUT", "Invalid expected notification account.", 400) });
  // A single URI component preserves non-UUID IDs without accepting duplicate
  // headers coalesced with commas. Decode exactly once; percent is valid in IDs.
  if (raw.length > 3600 || !/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-f]{2})+$/i.test(raw)) return invalid();
  let actorId: string;
  try { actorId = decodeURIComponent(raw); } catch { return invalid(); }
  if (!actorId || actorId.length > 300 || actorId.trim() !== actorId || /[\u0000-\u001f\u007f]/u.test(actorId)) return invalid();
  return { actorId };
}

function forwardNotification(request: Request, path: string, method: ForwardMethod, config: ApiProxyConfig): Promise<Response> {
  const expected = expectedNotificationActor(request);
  if (expected.response) return Promise.resolve(expected.response);
  // The shared forwarder verifies /me with the resource's bearer and repeats
  // verification after rotation. It never forwards this browser-only header.
  return forwardAuthoringRequest(request, path, method, config, undefined, undefined, expected.actorId);
}

/** The inbox shows at most this many notices; the API paginates the rest. */
export const NOTIFICATIONS_LIMIT = 50;

/** The API's own ceiling for one page of the inbox. */
export const NOTIFICATIONS_LIMIT_MAX = 100;

/**
 * The cursor is opaque to this proxy: it is a base64url string the API produced,
 * and the only thing worth checking is that it is one — forwarding arbitrary
 * bytes would turn a local mistake into an upstream `400` the reader cannot see.
 */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * The inbox's address, with an optional cursor continuing an earlier page.
 *
 * `cursor` is the `(createdAt, id)` of the last notice already shown, encoded by
 * whoever produced the page — the browser builds it from the row it has, which is
 * what keeps the response a plain array.
 */
export function notificationsPath(limit: number = NOTIFICATIONS_LIMIT, cursor: string | null = null): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== null) query.set("cursor", cursor);
  return `api/v1/me/notifications?${query.toString()}`;
}

export function notificationsUnreadCountPath(): string {
  return "api/v1/me/notifications/unread-count";
}

export function notificationsReadAllPath(): string {
  return "api/v1/me/notifications/read-all";
}

export function notificationReadPath(id: string): string {
  return `api/v1/me/notifications/${encodeURIComponent(id)}/read`;
}

function methodOf(request: Request, allowed: readonly string[]): string | null {
  const method = request.method.toUpperCase();
  return allowed.includes(method) ? method : null;
}

function rejectCrossOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host")) === false;
}

/**
 * `GET /api/notifications` — the signed-in reader's inbox.
 *
 * A 401 is an answer, not an error: the desk renders its "sign in first" panel
 * from it. The refresh-and-retry and the cookie clearing on a rejected refresh
 * token are `forwardAuthoringRequest`'s job.
 *
 * `limit` and `cursor` are re-validated here rather than passed through, for the
 * same reason the media library does it: a value the API would reject should be
 * rejected where the page can explain it. Anything else in the query string is
 * dropped — this proxy forwards two parameters, not whatever the caller typed.
 */
export async function handleNotificationsRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for notifications.", 405);
  }
  const params = new URL(request.url).searchParams;
  const rawCursor = params.get("cursor");
  if (rawCursor !== null && CURSOR_PATTERN.test(rawCursor) === false) {
    return errorResponse("BAD_USER_INPUT", "Invalid cursor.", 400);
  }
  const rawLimit = params.get("limit");
  let limit = NOTIFICATIONS_LIMIT;
  if (rawLimit !== null) {
    const parsed = /^[1-9][0-9]{0,2}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > NOTIFICATIONS_LIMIT_MAX) {
      return errorResponse("BAD_USER_INPUT", `limit must be a whole number between 1 and ${NOTIFICATIONS_LIMIT_MAX}.`, 400);
    }
    limit = parsed;
  }
  return forwardNotification(request, notificationsPath(limit, rawCursor), "GET", config);
}

/** `GET /api/notifications/unread-count` — how many of them are still unread. */
export async function handleNotificationsUnreadCountRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for the unread count.", 405);
  }
  return forwardNotification(request, notificationsUnreadCountPath(), "GET", config);
}

/**
 * `POST /api/notifications/read-all` — mark every notice read.
 *
 * No body: it addresses the whole inbox of the session's own reader, so it is
 * forwarded without the body ceiling a text write is subject to.
 */
export async function handleNotificationsReadAllRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for marking every notification read.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  return forwardNotification(request, notificationsReadAllPath(), "POST", config);
}

/**
 * `PUT /api/notifications/:id/read` — mark one notice read.
 *
 * Method, then Origin, then the id, in the order every other mutation here
 * uses, so a cross-origin caller cannot use the status code to learn which
 * notification ids exist.
 */
export async function handleNotificationReadRequest(
  request: Request,
  params: { id: string },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["PUT"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only PUT is supported for marking a notification read.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  if (!NOTIFICATION_ID_PATTERN.test(params.id)) {
    return errorResponse("BAD_USER_INPUT", "Invalid notification ID.", 400);
  }
  return forwardNotification(request, notificationReadPath(params.id), "PUT", config);
}
