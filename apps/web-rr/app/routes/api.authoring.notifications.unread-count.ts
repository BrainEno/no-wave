import type { LoaderFunctionArgs } from "react-router";
import { handleNotificationsUnreadCount } from "../lib/notifications-proxy.ts";

/** `GET /api/authoring/notifications/unread-count` — resource route, no component. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleNotificationsUnreadCount(request);
}
