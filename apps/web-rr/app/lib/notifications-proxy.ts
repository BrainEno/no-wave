import {
  handleNotificationReadRequest,
  handleNotificationsReadAllRequest,
  handleNotificationsRequest,
  handleNotificationsUnreadCountRequest,
} from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "./runtime.ts";

/**
 * React Router binding for the notification inbox.
 *
 * The reads and writes are one implementation in `@bot-thk/web-http`, shared
 * with the App Router's route handlers; the only framework-specific step left
 * is resolving the server-only API origin, exactly like the authoring, comments
 * and media adapters.
 */
export function handleNotifications(request: Request): Promise<Response> {
  return handleNotificationsRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
}

export function handleNotificationsUnreadCount(request: Request): Promise<Response> {
  return handleNotificationsUnreadCountRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
}

export function handleNotificationsReadAll(request: Request): Promise<Response> {
  return handleNotificationsReadAllRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
}

export function handleNotificationRead(request: Request, id: string | undefined): Promise<Response> {
  return handleNotificationReadRequest(request, { id: id ?? "" }, { apiBaseUrl: optionalApiBaseUrl() });
}
