import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * `GET`/`PUT /api/authoring/profile` — the writing desk's pen name.
 *
 * The API owns the author profile, but the browser cannot attach its HttpOnly
 * token to `api/v1/me/profile`; this shared proxy does it. A read is a plain
 * forward, while a pen-name edit is a mutation: exact same-origin Origin first,
 * then a bounded JSON body, then the forwarder. No framework code lives here.
 */

export const AUTHORING_PROFILE_PATH = "api/v1/me/profile";
export const AUTHORING_PROFILE_BODY_MAX_BYTES = 4096;
export const AUTHORING_PROFILE_DEFAULT_LOCALE = "zh-CN";

export function authoringProfilePath(locale: string = AUTHORING_PROFILE_DEFAULT_LOCALE): string {
  return `${AUTHORING_PROFILE_PATH}?locale=${encodeURIComponent(locale)}`;
}

export async function handleAuthoringProfileRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "PUT") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and PUT are supported for the author profile.", 405);
  }
  if (method === "GET") {
    return forwardAuthoringRequest(request, authoringProfilePath(), "GET", config);
  }
  if (!isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"))) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, AUTHORING_PROFILE_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, AUTHORING_PROFILE_PATH, "PUT", config, body.text);
}
