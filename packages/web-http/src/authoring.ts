import type { ApiProxyConfig } from "./api.ts";
import { readLimitedJson } from "./body.ts";
import { forwardAuthoringRequest } from "./forward.ts";
import { errorResponse, isRecord } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";

/**
 * The writing desk's browser-facing proxy (ADR 0012, Phase 4b).
 *
 * `AuthoringWorkspace` is a shared client component: it asks for the session,
 * lists the author's articles, creates one, updates one, deletes one, lists the
 * deleted ones and restores one. Those calls are what make the desk
 * interactive, and until this module existed they were only served by the App
 * Router — the same failure the comment section had in Phase 4a, where a page
 * rendered correctly and had nothing to talk to.
 *
 * The behaviour is shared rather than re-implemented per framework: the
 * exact-Origin check on mutations, the article-id shape check, the bounded body,
 * cookie-attached forwarding with refresh-and-retry and the no-store policy all
 * live here, and each framework contributes only a route adapter.
 *
 * Nothing in this file imports a framework.
 */

/** The address shape a slug must have before it is forwarded to the API. */
export const AUTHORING_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * How many works one export may name.
 *
 * The same ceiling the API enforces. Checked here as well so a browser asking for
 * a thousand works gets one 400 from the proxy instead of an upstream request
 * that reads a thousand links to answer the same thing.
 */
export const AUTHORING_EXPORT_MAX_WORKS = 50;

/** Article ids are UUIDs; the shape is checked before proxying. */
export const AUTHORING_ARTICLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * An article body carries the whole Lexical document, so the ceiling is
 * generous — it is the value the App Router already used, kept identical so the
 * extraction changes no observable behaviour.
 */
export const AUTHORING_BODY_MAX_BYTES = 2_000_000;

/** Restrictive browser-to-proxy precondition, not an authentication credential. */
export const AUTHORING_EXPECTED_ACTOR_HEADER = "x-expected-author";
/** Set only on a rejection the proxy answers itself, never on an upstream response. */
export const AUTHORING_NOT_FORWARDED_HEADER = "x-authoring-not-forwarded";

function notForwarded(response: Response): Response {
  response.headers.set(AUTHORING_NOT_FORWARDED_HEADER, "1");
  return response;
}

/** The desk lists at most this many editions per locale. */
export const AUTHORING_ARTICLES_LIMIT = 100;

export const AUTHORING_DEFAULT_LOCALE = "zh-CN";

export const AUTHORING_LOCALES: readonly string[] = Object.freeze(["zh-CN", "zh-TW", "en"]);

export function isAuthoringLocale(locale: string): boolean {
  return AUTHORING_LOCALES.includes(locale);
}

export function authoringArticlesPath(
  locale: string = AUTHORING_DEFAULT_LOCALE,
  limit: number = AUTHORING_ARTICLES_LIMIT,
): string {
  return `api/v1/me/articles?locale=${encodeURIComponent(locale)}&limit=${encodeURIComponent(String(limit))}`;
}

export function authoringArticlePath(id: string): string {
  return `api/v1/articles/${encodeURIComponent(id)}`;
}

/** The desk's recycle bin: the author's own tombstones. */
export function authoringDeletedArticlesPath(
  locale: string = AUTHORING_DEFAULT_LOCALE,
  limit: number = AUTHORING_ARTICLES_LIMIT,
): string {
  return `api/v1/me/articles/deleted?locale=${encodeURIComponent(locale)}&limit=${encodeURIComponent(String(limit))}`;
}

/**
 * The Notion export, as the API spells it.
 *
 * The list travels as one comma-separated parameter because the API refuses a
 * repeated query parameter outright: a request it cannot read unambiguously is
 * answered, not guessed.
 */
export function authoringNotionExportPath(slugs: readonly string[]): string {
  return `api/v1/imports/notion/export?slugs=${slugs.map((slug) => encodeURIComponent(slug)).join(",")}`;
}

export function authoringRestoreArticlePath(id: string, locale?: string): string {
  const path = `api/v1/articles/${encodeURIComponent(id)}/restore`;
  return locale === undefined ? path : `${path}?locale=${encodeURIComponent(locale)}`;
}

type ListSelection = { locale: string } | { allLocales: true };

/** Do not silently reinterpret an invalid or ambiguous locale as zh-CN. */
function listSelection(request: Request): ListSelection | null {
  const params = new URL(request.url).searchParams;
  const locales = params.getAll("locale");
  const all = params.getAll("allLocales");
  if (locales.length > 1 || all.length > 1) return null;
  if (all.length === 1) return all[0] === "true" && locales.length === 0 ? { allLocales: true } : null;
  const locale = locales[0] ?? AUTHORING_DEFAULT_LOCALE;
  return isAuthoringLocale(locale) ? { locale } : null;
}

function allLocalesPath(deleted: boolean): string {
  const path = deleted ? "api/v1/me/articles/deleted" : "api/v1/me/articles";
  return `${path}?allLocales=true&limit=${AUTHORING_ARTICLES_LIMIT}`;
}

function methodOf(request: Request, allowed: readonly string[]): string | null {
  const method = request.method.toUpperCase();
  return allowed.includes(method) ? method : null;
}

function rejectCrossOrigin(request: Request): boolean {
  return isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host")) === false;
}

/**
 * `GET /api/authoring/session` — who is signed in, if anyone.
 *
 * A 401 is an answer, not an error: the workspace renders its "sign in first"
 * panel from it. The refresh-and-retry and the cookie clearing on a rejected
 * refresh token are `forwardAuthoringRequest`'s job.
 */
export async function handleAuthoringSessionRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for the session.", 405);
  }
  return forwardAuthoringRequest(request, "api/v1/me", "GET", config);
}

/**
 * `GET`/`POST /api/authoring/articles` — the author's list, and a new work.
 *
 * The Origin check precedes everything else on the write, so a cross-origin
 * request never learns what the endpoint accepts.
 */
export async function handleAuthoringArticlesRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET", "POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET and POST are supported for articles.", 405);
  }
  if (method === "GET") {
    const selection = listSelection(request);
    if (!selection) return errorResponse("BAD_USER_INPUT", "Invalid locale or allLocales query parameter.", 400);
    const path = "allLocales" in selection ? allLocalesPath(false) : authoringArticlesPath(selection.locale);
    return forwardAuthoringRequest(request, path, "GET", config);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, AUTHORING_BODY_MAX_BYTES);
  if (!body.ok) return notForwarded(body.response);
  const rawExpectedActor = request.headers.get(AUTHORING_EXPECTED_ACTOR_HEADER);
  let expectedActorId: string | undefined;
  if (rawExpectedActor !== null) {
    try { expectedActorId = decodeURIComponent(rawExpectedActor); } catch {
      return notForwarded(errorResponse("BAD_USER_INPUT", "Invalid expected author.", 400));
    }
    if (!expectedActorId || expectedActorId.length > 300 || expectedActorId.trim() !== expectedActorId) {
      return notForwarded(errorResponse("BAD_USER_INPUT", "Invalid expected author.", 400));
    }
  }
  return forwardAuthoringRequest(request, "api/v1/articles", "POST", config, body.text, undefined, expectedActorId);
}

/**
 * `PUT /api/authoring/articles/:id` — save or publish an existing work.
 * `DELETE /api/authoring/articles/:id` — delete it.
 *
 * Order matters and is the App Router's order: the method is checked first, then
 * the Origin, then the id, so a cross-origin caller cannot use the status code to
 * probe which article ids exist, and a DELETE is refused for its origin before
 * anything looks at the work it names.
 *
 * DELETE carries no body, so it is forwarded without the body ceiling a save is
 * subject to.
 */
export async function handleAuthoringArticleRequest(
  request: Request,
  params: { id: string },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["PUT", "DELETE"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only PUT and DELETE are supported for an article.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  if (!AUTHORING_ARTICLE_ID_PATTERN.test(params.id)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article ID.", 400);
  }
  if (method === "DELETE") {
    return forwardAuthoringRequest(request, authoringArticlePath(params.id), "DELETE", config);
  }
  const body = await readLimitedJson(request, AUTHORING_BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  return forwardAuthoringRequest(request, authoringArticlePath(params.id), "PUT", config, body.text);
}

/**
 * `GET /api/authoring/deleted-articles` — the author's own deleted works.
 *
 * The list that makes a soft delete recoverable: without it, a deleted work is
 * invisible, which is the one thing an author cannot tell apart from a bug. It
 * is a read, so it needs no Origin check; the API still answers 401 without a
 * session, which is how the workspace decides to show the sign-in panel.
 */
export async function handleAuthoringDeletedArticlesRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for deleted articles.", 405);
  }
  const selection = listSelection(request);
  if (!selection) return errorResponse("BAD_USER_INPUT", "Invalid locale or allLocales query parameter.", 400);
  const path = "allLocales" in selection ? allLocalesPath(true) : authoringDeletedArticlesPath(selection.locale);
  return forwardAuthoringRequest(request, path, "GET", config);
}

/**
 * `GET /api/authoring/notion-export?slugs=` — the author's own works as a Notion
 * bundle they can download (ADR 0036, phase 3).
 *
 * The API's answer *is* the file, so the proxy marks it as an attachment: the
 * browser saves it instead of rendering it, and the desk's "export to Notion"
 * link needs no client-side blob handling. A failure keeps the JSON error the
 * API sent (and the proxy's own 400 for a slug it can see is not one), because a
 * download that silently saves an error page would be worse than no download.
 */
export async function handleAuthoringNotionExportRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["GET"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported for an export.", 405);
  }
  const raw = new URL(request.url).searchParams.getAll("slugs");
  if (raw.length !== 1) {
    return errorResponse("BAD_USER_INPUT", "Exactly one `slugs` query parameter is required.", 400);
  }
  const slugs = [...new Set(raw[0]!.split(",").map((slug) => slug.trim()).filter((slug) => slug.length > 0))];
  if (slugs.length === 0) {
    return errorResponse("BAD_USER_INPUT", "`slugs` must name at least one work.", 400);
  }
  if (slugs.length > AUTHORING_EXPORT_MAX_WORKS) {
    return errorResponse(
      "BAD_USER_INPUT",
      `At most ${AUTHORING_EXPORT_MAX_WORKS} works can be exported in one request.`,
      400,
    );
  }
  for (const slug of slugs) {
    if (slug.length > 160 || !AUTHORING_SLUG_PATTERN.test(slug)) {
      return errorResponse("BAD_USER_INPUT", `\`${slug}\` is not a work address.`, 400);
    }
  }

  const upstream = await forwardAuthoringRequest(request, authoringNotionExportPath(slugs), "GET", config);
  if (!upstream.ok) return upstream;
  // Rebuilt rather than mutated: the forwarder's answer already carries the
  // no-store policy and any rotated session cookie, and both are kept.
  const headers = new Headers(upstream.headers);
  headers.set("content-disposition", 'attachment; filename="notion-bundle.json"');
  return new Response(await upstream.text(), { status: upstream.status, headers });
}

/**
 * How large a Notion bundle may be before it is refused.
 *
 * The API's own ceiling (`MAX_NOTION_IMPORT_BYTES`), repeated here for the same
 * reason the media upload repeats its limit: the proxy holds the bytes while it
 * reads them, so the decision belongs where they arrive rather than one hop later.
 */
export const AUTHORING_NOTION_IMPORT_MAX_BYTES = 8 * 1024 * 1024 + 512 * 1024 + 1024;

/**
 * `POST /api/authoring/notion-import` — import a Notion bundle into the caller's
 * own works (ADR 0036, phase 4).
 *
 * The desk sends the file the author chose and the one decision the browser is
 * allowed to make: whether this is the dry run or the write. Everything else —
 * whether the bundle is one, which pages are new, which are unchanged since the
 * last import, which are refused and why — is the API's answer, and the proxy
 * passes it through untouched so the page shows the report the server produced.
 *
 * The body is forwarded as the *text* that arrived. Re-serialising it would
 * rewrite a document the author chose, and the import's "unchanged since last
 * time" check is a digest of what the server received.
 */
export async function handleAuthoringNotionImportRequest(
  request: Request,
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for an import.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  const body = await readLimitedJson(request, AUTHORING_NOTION_IMPORT_MAX_BYTES);
  if (!body.ok) return notForwarded(body.response);

  // `apply` decides whether anything is written, so an ambiguous value is answered
  // rather than coerced: `"true"` from a hand-written client must not become a write.
  if (body.value.apply !== undefined && typeof body.value.apply !== "boolean") {
    return notForwarded(errorResponse("BAD_USER_INPUT", "`apply` must be a boolean when present.", 400));
  }
  if (!isRecord(body.value.bundle)) {
    return notForwarded(errorResponse("BAD_USER_INPUT", "A `bundle` object is required.", 400));
  }

  if (new TextEncoder().encode(JSON.stringify(body.value.bundle)).byteLength > 8 * 1024 * 1024) {
    return notForwarded(errorResponse("PAYLOAD_TOO_LARGE", "The bundle exceeds the 8 MB limit.", 413));
  }

  return forwardAuthoringRequest(request, "api/v1/imports/notion", "POST", config, body.text);
}

/**
 * `POST /api/authoring/articles/:id/restore` — bring a deleted work back.
 *
 * The same order as a save and a delete: the method first, then the Origin, then
 * the id, so a cross-origin caller cannot use the status code to probe which ids
 * exist. Restoring carries no body — it addresses a work the author already has
 * — so it is forwarded without the body ceiling a save is subject to.
 */
export async function handleAuthoringRestoreRequest(
  request: Request,
  params: { id: string },
  config: ApiProxyConfig = {},
): Promise<Response> {
  const method = methodOf(request, ["POST"]);
  if (method === null) {
    return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported for restoring an article.", 405);
  }
  if (rejectCrossOrigin(request)) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }
  if (!AUTHORING_ARTICLE_ID_PATTERN.test(params.id)) {
    return errorResponse("BAD_USER_INPUT", "Invalid article ID.", 400);
  }
  const query = new URL(request.url).searchParams;
  const locales = query.getAll("locale");
  if (query.has("allLocales") || locales.length > 1 || (locales.length === 1 && !isAuthoringLocale(locales[0]))) {
    return errorResponse("BAD_USER_INPUT", "Invalid locale query parameter.", 400);
  }
  return forwardAuthoringRequest(request, authoringRestoreArticlePath(params.id, locales[0]), "POST", config);
}
