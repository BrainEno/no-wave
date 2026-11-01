import type { ActionFunctionArgs } from "react-router";
import { handleAccountSessionEnd } from "../lib/account-proxy.ts";

/**
 * `DELETE /api/authoring/sessions/:id` — resource route, no component.
 *
 * The id is shape-checked inside the shared handler, after the Origin check, so
 * the status code cannot be used to probe which session ids exist.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleAccountSessionEnd(request, String(params.id ?? ""));
}
