import type { ActionFunctionArgs } from "react-router";
import { handleMediaUploadRequest } from "@bot-thk/web-http";
import { optionalApiBaseUrl } from "../lib/runtime.ts";

/**
 * Authenticated image upload (`POST /api/authoring/media`).
 *
 * The access token is an HttpOnly cookie, so the browser cannot reach the API
 * itself; the shared adapter forwards the bytes with the token attached server
 * side, after enforcing the Origin check, content-type allow-list and size
 * ceiling.
 */
export async function action({ request }: ActionFunctionArgs) {
  return handleMediaUploadRequest(request, { apiBaseUrl: optionalApiBaseUrl() });
}
