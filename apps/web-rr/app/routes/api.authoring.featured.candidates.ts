import type { LoaderFunctionArgs } from "react-router";
import { handleAuthoringFeaturedCandidates } from "../lib/authoring-proxy.ts";

/**
 * `GET /api/authoring/featured/candidates` — resource route, no component.
 *
 * A read, so it is a loader; the shared handler owns the query it builds.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringFeaturedCandidates(request);
}
