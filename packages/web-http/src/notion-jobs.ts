import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse, isRecord } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";
import { AUTHORING_ARTICLE_ID_PATTERN, AUTHORING_EXPECTED_ACTOR_HEADER, AUTHORING_NOTION_IMPORT_MAX_BYTES } from "./authoring.ts";

const JOBS_PATH = "api/v1/imports/notion/jobs";
const ETAG = /^"[A-Za-z0-9_-]{43}"$/;
const invalid = () => errorResponse("BAD_USER_INPUT", "Invalid import job request. Use only a bundle and its signed preview plan.", 400);
function sameOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"));
}

/** No fixtures and no UI migration: a browser can opt into the default-disabled API. */
export async function handleNotionJobsRequest(request: Request, config: ApiProxyConfig = {}): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Only GET and POST are supported for import jobs.", 405);
  if (method === "POST" && !sameOrigin(request)) return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  const search = new URL(request.url).searchParams;
  if (method === "GET") {
    const requestKey = request.headers.get("idempotency-key");
    if (requestKey !== null && (!/^[A-Za-z0-9_-]{16,128}$/.test(requestKey) || search.size)) return invalid();
    if ([...search.keys()].some(key => key !== "limit") || search.getAll("limit").length > 1) return invalid();
    const limit = search.get("limit");
    if (limit !== null && !/^(?:[1-9]|1[0-9]|20)$/.test(limit)) return invalid();
    return forwardAuthoringRequest(request, JOBS_PATH + (limit === null ? "" : `?limit=${limit}`), "GET", config);
  }
  if (search.size || !/^[A-Za-z0-9_-]{16,128}$/.test(request.headers.get("idempotency-key") ?? "")) return invalid();
  let expectedActorId: string | undefined;
  const expected = request.headers.get(AUTHORING_EXPECTED_ACTOR_HEADER);
  if (expected !== null) {
    try { expectedActorId = decodeURIComponent(expected); } catch { return invalid(); }
    if (!expectedActorId || expectedActorId.length > 200 || /[\u0000-\u001f\u007f]/.test(expectedActorId)) return invalid();
  }
  const body = await readLimitedJson(request, AUTHORING_NOTION_IMPORT_MAX_BYTES);
  if (!body.ok) return body.response;
  if (Object.keys(body.value).some(key => key !== "bundle" && key !== "planToken") || !isRecord(body.value.bundle) ||
      typeof body.value.planToken !== "string" || body.value.planToken.length === 0 || body.value.planToken.length > 524288) return invalid();
  // The API authenticates the actual owner, verifies the signature and applies queue limits.
  return forwardAuthoringRequest(request, JOBS_PATH, "POST", config, body.text, undefined, expectedActorId);
}

/** Conditional polling is opt-in and bounded; cancel never masquerades as safe-to-replay. */
export async function handleNotionJobRequest(request: Request, params: { id: string }, config: ApiProxyConfig = {}): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "DELETE") return errorResponse("METHOD_NOT_ALLOWED", "Only GET and DELETE are supported for an import job.", 405);
  if (method === "DELETE" && !sameOrigin(request)) return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  if (!AUTHORING_ARTICLE_ID_PATTERN.test(params.id) || new URL(request.url).searchParams.size) return invalid();
  const path = `${JOBS_PATH}/${encodeURIComponent(params.id)}`;
  if (method === "DELETE") return forwardAuthoringRequest(request, path, "DELETE", config);
  const etag = request.headers.get("if-none-match"), prefer = request.headers.get("prefer");
  if ((etag !== null && !ETAG.test(etag)) || (prefer !== null && !/^wait=[0-5]$/.test(prefer))) return invalid();
  return forwardAuthoringRequest(request, path, "GET", config, undefined, undefined, undefined, false,
    { ...(etag === null ? {} : { etag }), ...(prefer === null ? {} : { prefer }) });
}
