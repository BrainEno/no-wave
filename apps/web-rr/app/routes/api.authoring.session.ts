import type { LoaderFunctionArgs } from "react-router";
import { handleAuthoringSession } from "../lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/session` — resource route, no component.
 *
 * The first thing `AuthoringWorkspace` asks after it hydrates. Without it the
 * desk renders its loading line and stays there, which is why the endpoint is
 * part of the port rather than a follow-up: the component is shared, so the page
 * would look migrated and be dead.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringSession(request);
}
