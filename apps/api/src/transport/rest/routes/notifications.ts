import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { decodeCursor } from "../../../domain/cursor.ts";
import { authenticatedActorId, decodeUserId, parseInteger, sendBadInput, sendJson, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { serializeRestNotification } from "../serializers.ts";

/** The notification inbox (`me.notifications*`). */
const NOTIFICATION_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  /**
   * `GET /api/v1/me/notifications` — the signed-in reader's inbox, newest first.
   *
   * `cursor` continues an earlier page: it names the last notification the client
   * already has, and the answer is the next older slice. Without one the request
   * is the first page, exactly as it always was.
   *
   * The cursor is validated here rather than in the store because a malformed one
   * can only fail *in the database* — it is half of a sort key — and a `500` for a
   * client mistake would be the wrong answer twice over. The recipient always
   * comes from the verified token; there is no parameter that names another
   * reader's inbox.
   */
  "me.notifications": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return; }
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    if (rawCursor !== null && cursor === null) { sendBadInput(response, "Invalid cursor query parameter."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const notifications = await services.listNotifications(cursor === null ? { actorId, limit } : { actorId, limit, cursor });
      sendJson(response, 200, { data: Array.isArray(notifications) ? notifications.map(serializeRestNotification) : [] });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "me.notifications.unread-count": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const count = await services.getUnreadNotificationCount({ actorId });
      sendJson(response, 200, { data: count });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "me.notifications.read": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const notificationId = decodeUserId(routeParams.id);
    if (!notificationId) { sendBadInput(response, "Invalid notification ID."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const notification = await services.markNotificationRead({ notificationId, actorId });
      sendJson(response, 200, { data: serializeRestNotification(notification) });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
  "me.notifications.read-all": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const count = await services.markAllNotificationsRead({ actorId });
      sendJson(response, 200, { data: count });
    } catch (error: unknown) { sendServiceError(response, error); }
  },
});

export const NOTIFICATION_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(NOTIFICATION_ROUTE_HANDLERS));

export async function handleNotificationRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = NOTIFICATION_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
