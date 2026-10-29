import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { authenticatedActorId, decodeUserId, parseInteger, sendBadInput, sendJson, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { serializeRestNotification } from "../serializers.ts";

/** The notification inbox (`me.notifications*`). */
const NOTIFICATION_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "me.notifications": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
    if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return; }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const notifications = await services.listNotifications({ actorId, limit });
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
