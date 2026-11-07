import {
  handleNotificationReadRequest,
  handleNotificationsReadAllRequest,
  handleNotificationsRequest,
  handleNotificationsUnreadCountRequest,
} from "@bot-thk/web-http";
import { apiProxyConfig } from "./runtime.ts";

/**
 * React Router binding for the notification inbox.
 *
 * The reads and writes are one implementation in `@bot-thk/web-http`, shared by
 * every route that serves them; the only step left here is resolving the
 * server-only API origin, exactly like the authoring, comments
 * and media adapters.
 */
export function handleNotifications(request: Request): Promise<Response> {
  return handleNotificationsRequest(request, apiProxyConfig());
}

export function handleNotificationsUnreadCount(request: Request): Promise<Response> {
  return handleNotificationsUnreadCountRequest(request, apiProxyConfig());
}

export function handleNotificationsReadAll(request: Request): Promise<Response> {
  return handleNotificationsReadAllRequest(request, apiProxyConfig());
}

export function handleNotificationRead(request: Request, id: string | undefined): Promise<Response> {
  return handleNotificationReadRequest(request, { id: id ?? "" }, apiProxyConfig());
}
