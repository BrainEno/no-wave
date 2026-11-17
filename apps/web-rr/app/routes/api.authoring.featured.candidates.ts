import type { LoaderFunctionArgs } from "react-router";
import { handleAuthoringFeaturedCandidatesRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET /api/authoring/featured/candidates` — resource route, no component.
 *
 * A read, so it is a loader; the shared handler owns the query it builds.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringFeaturedCandidatesRequest(request, apiProxyConfig());
}
