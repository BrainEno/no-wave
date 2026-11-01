import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleAuthoringFeatured } from "../lib/authoring-proxy.ts";

/**
 * `GET`/`PUT /api/authoring/featured` — resource route, no component.
 *
 * The read is a loader and the write is an action, which is the framework's
 * distinction and not the contract's; the shared handler owns both the method
 * list and the origin check, so this route cannot drift from the other routes
 * that serve the same contract.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringFeatured(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleAuthoringFeatured(request);
}
