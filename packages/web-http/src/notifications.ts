import type { ApiProxyConfig } from "./api.ts";
import { forwardAuthoringRequest } from "./forward.ts";
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

/** The inbox shows at most this many notices; the API paginates the rest. */
export const NOTIFICATIONS_LIMIT = 50;

export function notificationsPath(limit: number = NOTIFICATIONS_LIMIT): string {
  return `api/v1/me/notifications?limit=${encodeURIComponent(String(limit))}`;
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
 */
export async function handleNotificationsRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for notifications.", 405);
  }
  return forwardAuthoringRequest(request, notificationsPath(), "GET", config);
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
  return forwardAuthoringRequest(request, notificationsUnreadCountPath(), "GET", config);
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
  return forwardAuthoringRequest(request, notificationsReadAllPath(), "POST", config);
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
  return forwardAuthoringRequest(request, notificationReadPath(params.id), "PUT", config);
}
