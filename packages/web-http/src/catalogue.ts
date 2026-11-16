import type { ApiProxyConfig } from "./api.ts";
import { AUTHORING_ARTICLE_ID_PATTERN, AUTHORING_EXPECTED_ACTOR_HEADER, authoringRestoreArticlePath, isAuthoringLocale } from "./authoring.ts";
import { forwardAuthoringRequest as forwardPrivateRequest } from "./forward.ts";
import { errorResponse as privateError } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

function catalogueResponse(response: Response): Response {
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
}
function errorResponse(code: string, message: string, status: number): Response {
  return catalogueResponse(privateError(code, message, status));
}
async function forwardAuthoringRequest(...args: Parameters<typeof forwardPrivateRequest>): Promise<Response> {
  return catalogueResponse(await forwardPrivateRequest(...args));
}

const CATALOGUE_PARAMS = new Set(["scope", "q", "locale", "status", "workType", "sort", "from", "until", "limit", "cursor"]);

function catalogueActor(request: Request): string | null {
  const raw = request.headers.get(AUTHORING_EXPECTED_ACTOR_HEADER);
  if (!raw || raw.length > 2700) return null;
  try {
    const actor = decodeURIComponent(raw);
    return actor && actor.length <= 300 && actor === actor.trim() && !/[\u0000-\u001f\u007f\p{Cs}]/u.test(actor) ? actor : null;
  } catch { return null; }
}

/** The API owns semantics; the proxy refuses ambiguity/oversize before any private upstream work. */
function catalogueParameters(request: Request): URLSearchParams | null {
  const params = new URL(request.url).searchParams;
  for (const name of params.keys()) {
    if (!CATALOGUE_PARAMS.has(name) || params.getAll(name).length !== 1) return null;
    const maximum = name === "cursor" ? 1024 : name === "q" ? 120 : 40;
    if (params.get(name)!.length > maximum) return null;
  }
  if (params.has("limit") && (!/^[1-9]\d?$/.test(params.get("limit")!) || Number(params.get("limit")) > 50)) return null;
  return params;
}

export async function handleArticleCatalogueRequest(request: Request, config: ApiProxyConfig = {}): Promise<Response> {
  if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", "The catalogue is read-only.", 405);
  const actor = catalogueActor(request), params = catalogueParameters(request);
  if (!actor || !params) return errorResponse("BAD_USER_INPUT", "A valid expected account and unambiguous catalogue query are required.", 400);
  return forwardAuthoringRequest(request, `api/v1/me/article-catalogue?${params}`, "GET", config, undefined, undefined, actor);
}

function catalogueEdition(request: Request, id: string): string | null {
  const params = new URL(request.url).searchParams;
  const locales = params.getAll("locale");
  return AUTHORING_ARTICLE_ID_PATTERN.test(id) && locales.length === 1 && isAuthoringLocale(locales[0]!) &&
    [...params.keys()].every(name => name === "locale") ? locales[0]! : null;
}

export async function handleCatalogueArticleRequest(request: Request, params: { id: string }, config: ApiProxyConfig = {}): Promise<Response> {
  if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for an editable catalogue edition.", 405);
  const actor = catalogueActor(request), locale = catalogueEdition(request, params.id);
  if (!actor || !locale) return errorResponse("BAD_USER_INPUT", "A valid expected account, article ID and locale are required.", 400);
  return forwardAuthoringRequest(request, `api/v1/me/article-catalogue/${encodeURIComponent(params.id)}?locale=${encodeURIComponent(locale)}`, "GET", config, undefined, undefined, actor);
}

/** Restrict a restore to the account that actually reviewed the directory entry. */
export async function handleCatalogueRestoreRequest(request: Request, params: { id: string }, config: ApiProxyConfig = {}): Promise<Response> {
  if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for restoring a catalogue work.", 405);
  if (!isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"))) return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  const actor = catalogueActor(request), locale = catalogueEdition(request, params.id);
  if (!actor || !locale) return errorResponse("BAD_USER_INPUT", "A valid expected account, article ID and locale are required.", 400);
  return forwardAuthoringRequest(request, authoringRestoreArticlePath(params.id, locale), "POST", config, undefined, undefined, actor);
}

export async function handleCatalogueEditionsRequest(request: Request, params: { id: string }, config: ApiProxyConfig = {}): Promise<Response> {
  if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for catalogue editions.", 405);
  const query = new URL(request.url).searchParams;
  const actor = catalogueActor(request), scope = query.get("scope") ?? "active";
  if (!actor || !AUTHORING_ARTICLE_ID_PATTERN.test(params.id) || scope !== "active" && scope !== "trash" || query.getAll("scope").length > 1 || [...query.keys()].some(key => key !== "scope")) return errorResponse("BAD_USER_INPUT", "Invalid catalogue account, work or scope.", 400);
  return forwardAuthoringRequest(request, `api/v1/me/article-catalogue/${encodeURIComponent(params.id)}/editions?scope=${scope}`, "GET", config, undefined, undefined, actor);
}
