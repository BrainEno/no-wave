import type { LoaderFunctionArgs } from "react-router";
import { handleNotificationsUnreadCountRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/** `GET /api/authoring/notifications/unread-count` — resource route, no component. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleNotificationsUnreadCountRequest(request, apiProxyConfig());
}
