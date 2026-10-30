import type { ActionFunctionArgs } from "react-router";
import { handleNotificationRead } from "../lib/notifications-proxy.ts";

/**
 * `PUT /api/authoring/notifications/:id/read` — resource route, no component.
 *
 * The id is shape-checked inside the shared handler, after the Origin check, so
 * the status code cannot be used to probe which notification ids exist.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleNotificationRead(request, params.id);
}
