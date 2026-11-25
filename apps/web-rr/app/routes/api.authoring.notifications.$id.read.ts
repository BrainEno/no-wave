import type { ActionFunctionArgs } from "react-router";
import { handleNotificationReadRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `PUT /api/authoring/notifications/:id/read` — resource route, no component.
 *
 * The id is shape-checked inside the shared handler, after the Origin check, so
 * the status code cannot be used to probe which notification ids exist.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleNotificationReadRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
