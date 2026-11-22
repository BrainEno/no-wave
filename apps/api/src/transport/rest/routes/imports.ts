import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { authenticatedActorId, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { NotionBundleError } from "../../../application/notion-bundle.ts";
import { MAX_EXPORT_WORKS, NotionExportRequestError, exportNotionBundle } from "../../../application/notion-export.ts";
import { NotionImportRequestError, importNotionBundle } from "../../../application/notion-import.ts";
import { fetchNotionImage } from "../../../infrastructure/notion-image-fetch.ts";
import { MAX_NOTION_PLAN_TOKEN_BYTES } from "../../../application/notion-import-plan.ts";
import type { NotionImageCopier } from "../../../application/notion-import-images.ts";
import { NotionFetchError, NotionFetchRequestError, fetchNotionPages, fetchNotionRows, readNotionFetchRequest } from "../../../application/notion-fetch.ts";
import { boundedNotionFetch, type NotionFetch } from "../../../infrastructure/notion-source.ts";

/**
 * A bundle is big on purpose: one page carries up to 200 blocks of up to 20,000
 * characters, and a work's editions arrive together. The default 2 MB JSON cap
 * would refuse a legitimate export, so this route raises it — and the page count,
 * not the byte count, is what bounds the work the request can cause.
 */
export const MAX_NOTION_IMPORT_BYTES = 8 * 1024 * 1024;
const MAX_NOTION_IMPORT_REQUEST_BYTES = MAX_NOTION_IMPORT_BYTES + MAX_NOTION_PLAN_TOKEN_BYTES + 1024;

/** `apply` is opt-in: a body without it is a dry run, never a write. */
function readApplyFlag(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
}

/** `NOTION_FETCH_ENABLED=false` turns the pull off; anything else leaves it on (ADR 0052, decision 8). */
export function notionFetchEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NOTION_FETCH_ENABLED?.trim().toLowerCase() !== "false";
}

/** The Notion transport, replaceable by a test so no test reaches api.notion.com. */
let notionFetchTransport: NotionFetch = boundedNotionFetch();
export function setNotionFetchTransportForTests(transport: NotionFetch | null): void {
  notionFetchTransport = transport ?? boundedNotionFetch();
}

/**
 * Pulls in flight in this process, overall and per author (ADR 0052). The rate
 * limit bounds how many pulls an author starts in ten minutes, not how many hold
 * a request open at once — and each one may hold it for 75 s with up to 6 MiB of
 * blocks in memory. Over either cap the answer is 503 with a short Retry-After,
 * which the desk waits out by itself; nothing is queued here.
 */
export const NOTION_FETCH_CONCURRENCY = Object.freeze({ total: 8, perActor: 2, retryAfterSeconds: 5 });
const notionFetchesInFlight = { total: 0, byActor: new Map<string, number>() };

function acquireNotionFetchSlot(actorId: string): (() => void) | null {
  const mine = notionFetchesInFlight.byActor.get(actorId) ?? 0;
  if (notionFetchesInFlight.total >= NOTION_FETCH_CONCURRENCY.total || mine >= NOTION_FETCH_CONCURRENCY.perActor) return null;
  notionFetchesInFlight.total += 1;
  notionFetchesInFlight.byActor.set(actorId, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    notionFetchesInFlight.total -= 1;
    const left = (notionFetchesInFlight.byActor.get(actorId) ?? 1) - 1;
    if (left > 0) notionFetchesInFlight.byActor.set(actorId, left); else notionFetchesInFlight.byActor.delete(actorId);
  };
}

/** The address shape a slug must have before it is looked up. */
const EXPORT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The works one export request names.
 *
 * `slugs` is a comma-separated list rather than a repeated parameter, because the
 * transport refuses repeated query parameters outright (an ambiguous request is
 * answered, not guessed). Order is kept and duplicates are not an error: a caller
 * that pasted two lists together gets one page per work, which is what they meant.
 */
function readExportSlugs(url: URL): string[] | string {
  const raw = url.searchParams.get("slugs");
  if (raw === null) return "A `slugs` query parameter is required, for example `?slugs=qiangbi,cai-diao`.";
  const slugs = raw.split(",").map((slug) => slug.trim()).filter((slug) => slug.length > 0);
  if (slugs.length === 0) return "`slugs` must name at least one work.";
  for (const slug of slugs) {
    if (slug.length > 160 || !EXPORT_SLUG_PATTERN.test(slug)) {
      return `\`${slug}\` is not a work address; slugs are lowercase ASCII words joined by single hyphens.`;
    }
  }
  const unique = [...new Set(slugs)];
  if (unique.length > MAX_EXPORT_WORKS) {
    return `At most ${MAX_EXPORT_WORKS} works can be exported in one request; this one names ${unique.length}.`;
  }
  return unique;
}

/** Import endpoints (`imports.notion`, `imports.notion.export`). */
const IMPORT_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  /**
   * `POST /api/v1/imports/notion` — import a Notion bundle into the caller's own
   * works (ADR 0037).
   *
   * The body is `{ bundle, apply? }`. Without `apply: true` nothing is written:
   * the response is the plan, page by page, which is what a careful author wants
   * to read before the first write. Applying reports the same page list with what
   * actually happened, including the pages it refused and why.
   */
  "imports.notion": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, mediaAssets } = ctx;
    if (!services) { sendUnavailable(response); return; }

    const bodyResult = await readJsonObject(request, MAX_NOTION_IMPORT_REQUEST_BYTES);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }

    const apply = readApplyFlag(bodyResult.value.apply);
    if (apply === null) { sendBadInput(response, "`apply` must be a boolean when present."); return; }
    if (!("bundle" in bodyResult.value)) { sendBadInput(response, "A `bundle` object is required."); return; }
    if (Buffer.byteLength(JSON.stringify(bodyResult.value.bundle)) > MAX_NOTION_IMPORT_BYTES) {
      sendJson(response, 413, { error: { code: "PAYLOAD_TOO_LARGE", message: "The bundle exceeds the 8 MB limit." } });
      return;
    }

    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      // Per-request bound and cache. Never fetch a URL for a dry run; the
      // application invokes this only after checking the page's ownership.
      let attempted = 0;
      const copies = new Map<string, Awaited<ReturnType<NotionImageCopier>>>();
      const copyImage: NotionImageCopier = async (url, previousSrc) => {
        const cached = copies.get(url);
        if (cached) return cached;
        if (!mediaAssets) return { ok: false, reason: "media storage is not configured" };
        if (attempted >= 8) return { ok: false, reason: "image copy limit reached; retry the import" };
        attempted += 1;
        const fetched = await fetchNotionImage(url);
        if (!fetched.ok) return fetched;
        try {
          const reuseId = /^\/api\/media\/([0-9a-f-]{36})$/i.exec(previousSrc ?? "")?.[1];
          const asset = await mediaAssets.upload({ ownerId: actorId, bytes: fetched.bytes, contentType: fetched.contentType, ...(reuseId ? { reuseId } : {}) });
          const result = { ok: true as const, src: asset.src };
          copies.set(url, result);
          return result;
        } catch {
          return { ok: false, reason: "image could not be validated or stored" };
        }
      };
      const report = await importNotionBundle({
        actorId,
        bundle: bodyResult.value.bundle,
        apply,
        planToken: bodyResult.value.planToken,
        deps: services,
        copyImage,
      });
      sendJson(response, 200, { data: report });
    } catch (error: unknown) {
      // A bundle that is not a bundle is the caller's mistake, not ours: say
      // which shape was expected instead of a generic 500.
      if (error instanceof NotionBundleError || error instanceof NotionImportRequestError) {
        sendBadInput(response, error.message);
        return;
      }
      sendServiceError(response, error);
    }
  },

  /**
   * `POST /api/v1/imports/notion/fetch` — read the author's own Notion database
   * with the integration token they pasted, one bounded slice per request
   * (ADR 0052).
   *
   * `{ token, mode: "rows", source, cursor? }` lists rows; `{ token, mode:
   * "pages", pageIds }` reads bodies until the slice's time or byte budget runs
   * out and names what it finished in `done`. Nothing is written here and nothing
   * is kept: the token lives for this request only, and no response, error or log
   * line carries it — or Notion's own error text. Every failure below is answered
   * with a code built here, which is why this handler catches everything itself
   * instead of handing an unknown error to `sendServiceError`.
   */
  "imports.notion.fetch": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }
    const bodyResult = await readJsonObject(request);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }
    if (!notionFetchEnabled(env)) {
      sendJson(response, 409, { error: { code: "NOTION_FETCH_DISABLED", message: "Pulling from Notion is not enabled on this instance. Upload a Notion export instead." } });
      return;
    }

    let actorId: string | null;
    try {
      actorId = await authenticatedActorId(request, services, env);
    } catch (error: unknown) {
      sendServiceError(response, error);
      return;
    }
    if (!actorId) { sendUnauthenticated(response); return; }

    let release: (() => void) | null = null;
    try {
      const input = readNotionFetchRequest(bodyResult.value);
      release = acquireNotionFetchSlot(actorId);
      if (release === null) {
        response.setHeader("retry-after", String(NOTION_FETCH_CONCURRENCY.retryAfterSeconds));
        sendJson(response, 503, { error: { code: "NOTION_FETCH_BUSY", message: "Too many Notion pulls are running. Retry after the indicated time." } });
        return;
      }
      const deps = { fetchImpl: notionFetchTransport };
      const data = input.mode === "rows" ? await fetchNotionRows(input, deps) : await fetchNotionPages(input, deps);
      sendJson(response, 200, { data });
    } catch (error: unknown) {
      if (error instanceof NotionFetchRequestError) { sendBadInput(response, error.message); return; }
      const failure = error instanceof NotionFetchError ? error : new NotionFetchError("NOTION_UNAVAILABLE");
      if (failure.retryAfterSeconds !== null) response.setHeader("retry-after", String(Math.min(Math.max(failure.retryAfterSeconds, 1), 900)));
      sendJson(response, failure.status, { error: { code: failure.code, message: failure.message } });
    } finally {
      release?.();
    }
  },

  /**
   * `GET /api/v1/imports/notion/export?slugs=` — the caller's own works as a
   * Notion bundle (ADR 0036, phase 3).
   *
   * A read, so it is safe to repeat: nothing is written, no provenance row is
   * created, and exporting twice produces the same bundle. The response carries
   * the bundle under `data.bundle` and what it could not say under
   * `data.report` — which pages are updates of pages the author already has,
   * which requested works were not found, and where a round trip would differ.
   */
  "imports.notion.export": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, url, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }

    try {
      // The session comes first, like every other session-only read: an anonymous
      // caller learns nothing about what the endpoint accepts, and a caller who is
      // signed in gets the reason rather than a 401 for a typo.
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }

      const slugs = readExportSlugs(url);
      if (typeof slugs === "string") { sendBadInput(response, slugs); return; }

      const exported = await exportNotionBundle({ actorId, slugs, deps: services });
      sendJson(response, 200, { data: exported });
    } catch (error: unknown) {
      // Too many works, or none: the caller's mistake, answered with the reason.
      if (error instanceof NotionExportRequestError) {
        sendBadInput(response, error.message);
        return;
      }
      sendServiceError(response, error);
    }
  },
});

export const IMPORT_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(IMPORT_ROUTE_HANDLERS));

export async function handleImportRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = IMPORT_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
