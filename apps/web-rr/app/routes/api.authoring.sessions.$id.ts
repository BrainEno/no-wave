import type { ActionFunctionArgs } from "react-router";
import { handleAccountSessionEndRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `DELETE /api/authoring/sessions/:id` — resource route, no component.
 *
 * The id is shape-checked inside the shared handler, after the Origin check, so
 * the status code cannot be used to probe which session ids exist.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleAccountSessionEndRequest(request, { sessionId: String(params.id ?? "") }, apiProxyConfig());
}
