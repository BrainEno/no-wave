import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { authenticatedActorId, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { NotionBundleError } from "../../../application/notion-bundle.ts";
import { MAX_EXPORT_WORKS, NotionExportRequestError, exportNotionBundle } from "../../../application/notion-export.ts";
import { NotionImportRequestError, importNotionBundle } from "../../../application/notion-import.ts";
import { fetchNotionImage } from "../../../infrastructure/notion-image-fetch.ts";
import type { NotionImageCopier } from "../../../application/notion-import-images.ts";

/**
 * A bundle is big on purpose: one page carries up to 200 blocks of up to 20,000
 * characters, and a work's editions arrive together. The default 2 MB JSON cap
 * would refuse a legitimate export, so this route raises it — and the page count,
 * not the byte count, is what bounds the work the request can cause.
 */
export const MAX_NOTION_IMPORT_BYTES = 8 * 1024 * 1024;

/** `apply` is opt-in: a body without it is a dry run, never a write. */
function readApplyFlag(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
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

    const bodyResult = await readJsonObject(request, MAX_NOTION_IMPORT_BYTES);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }

    const apply = readApplyFlag(bodyResult.value.apply);
    if (apply === null) { sendBadInput(response, "`apply` must be a boolean when present."); return; }
    if (!("bundle" in bodyResult.value)) { sendBadInput(response, "A `bundle` object is required."); return; }

    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      // Per-request bound and cache. Never fetch a URL for a dry run; the
      // application invokes this only after checking the page's ownership.
      let attempted = 0;
      const copies = new Map<string, Awaited<ReturnType<NotionImageCopier>>>();
      const copyImage: NotionImageCopier = async (url) => {
        const cached = copies.get(url);
        if (cached) return cached;
        if (!mediaAssets) return { ok: false, reason: "media storage is not configured" };
        if (attempted >= 8) return { ok: false, reason: "image copy limit reached; retry the import" };
        attempted += 1;
        const fetched = await fetchNotionImage(url);
        if (!fetched.ok) return fetched;
        try {
          const asset = await mediaAssets.upload({ ownerId: actorId, bytes: fetched.bytes, contentType: fetched.contentType });
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
