import type { ActionFunctionArgs } from "react-router";
import { handleMediaDeleteRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `DELETE /api/authoring/media/:id` — resource route, no component (ADR 0022).
 *
 * The id is shape-checked inside the shared handler, after the Origin check, so
 * the status code cannot be used to probe which assets exist. Whether the asset
 * may be deleted at all is the API's decision, made against the content as it is
 * now — not as it was when the page was rendered.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleMediaDeleteRequest(request, { id: String(params.id ?? "") }, apiProxyConfig());
}
