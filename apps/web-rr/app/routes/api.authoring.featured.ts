import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringFeaturedRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET`/`PUT /api/authoring/featured` — resource route, no component.
 *
 * The read is a loader and the write is an action, which is the framework's
 * distinction and not the contract's; the shared handler owns both the method
 * list and the origin check, so this route cannot drift from the other routes
 * that serve the same contract.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringFeaturedRequest(request, apiProxyConfig());
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringFeaturedRequest(request, apiProxyConfig());
}
