import type { RestRouteContext } from "./context.ts";
import { authenticatedActorId, decodeUserId, parseInteger, sendBadInput, sendJson, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { serializeRestNotification } from "../serializers.ts";

/** The notification inbox (`me.notifications*`). */
export async function handleNotificationRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, url, services, env, routeParams, routeId } = ctx;

    if (routeId === "me.notifications") {
      if (!services) { sendUnavailable(response); return true; }
      const limit = parseInteger(url.searchParams, "limit", 50, 1, 100);
      if (limit === null) { sendBadInput(response, "Invalid limit query parameter."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const notifications = await services.listNotifications({ actorId, limit });
        sendJson(response, 200, { data: Array.isArray(notifications) ? notifications.map(serializeRestNotification) : [] });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "me.notifications.unread-count") {
      if (!services) { sendUnavailable(response); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const count = await services.getUnreadNotificationCount({ actorId });
        sendJson(response, 200, { data: count });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "me.notifications.read") {
      if (!services) { sendUnavailable(response); return true; }
      const notificationId = decodeUserId(routeParams.id);
      if (!notificationId) { sendBadInput(response, "Invalid notification ID."); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const notification = await services.markNotificationRead({ notificationId, actorId });
        sendJson(response, 200, { data: serializeRestNotification(notification) });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

    if (routeId === "me.notifications.read-all") {
      if (!services) { sendUnavailable(response); return true; }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const count = await services.markAllNotificationsRead({ actorId });
        sendJson(response, 200, { data: count });
      } catch (error: unknown) { sendServiceError(response, error); }
      return true;
    }

  return false;
}
