import type { LoaderFunctionArgs } from "react-router";
import { handleNotificationsUnreadCountRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/** `GET /api/authoring/notifications/unread-count` — resource route, no component. */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleNotificationsUnreadCountRequest(request, apiProxyConfig());
}
