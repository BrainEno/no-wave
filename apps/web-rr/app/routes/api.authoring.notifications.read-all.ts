import type { ActionFunctionArgs } from "react-router";
import { handleNotificationsReadAll } from "../lib/notifications-proxy.ts";

/**
 * `POST /api/authoring/notifications/read-all` — resource route, no component.
 *
 * Marking the whole inbox read is a write, so the Origin check applies; it is
 * the same check and the same order as every other mutation on the desk.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleNotificationsReadAll(request);
}
