import type { ActionFunctionArgs } from "react-router";
import { handleAuthoringRestoreRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `POST /api/authoring/articles/:id/restore` — resource route, no component.
 *
 * Undoing a deletion. It goes through the shared handler, so the Origin check,
 * the id-shape check and the refresh-and-retry are the ones every other desk
 * write already uses.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleAuthoringRestoreRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
