import type { ActionFunctionArgs } from "react-router";
import { handleAuthoringArticleRequest } from "@no-wave/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `PUT /api/authoring/articles/:id` — resource route, no component.
 *
 * Saving an existing work: the second and later saves of a document are updates,
 * not creates, which is what keeps the desk from producing a second article for
 * every press of the button.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleAuthoringArticleRequest(request, { id: params.id ?? "" }, apiProxyConfig());
}
