import type { LoaderFunctionArgs } from "react-router";
import { handlePublicMediaRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * Public media read (`GET /api/media/:id`) — resource route, no component.
 *
 * The implementation is the shared `@bot-thk/web-http` adapter, the same one the
 * every route that serves it: no second copy of the caching, ETag or size rules
 * exists, so the two frameworks cannot disagree about a media response.
 */
export async function loader({ params, request }: LoaderFunctionArgs) {
  return handlePublicMediaRequest(request, params.id ?? "", { apiBaseUrl: optionalApiBaseUrl() });
}
