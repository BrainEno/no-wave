import type { LoaderFunctionArgs } from "react-router";
import { handleAuthoringDeletedArticlesRequest } from "@bot-thk/web-http";
import { apiProxyConfig } from "../lib/runtime.ts";

/**
 * `GET /api/authoring/deleted-articles` — resource route, no component.
 *
 * The desk's recycle bin. A read, so it is a loader rather than an action; the
 * shared handler still owns the no-store policy and the token handling, so this
 * route cannot drift from the other routes that serve the same contract.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthoringDeletedArticlesRequest(request, apiProxyConfig());
}
