import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import { authenticatedActorId, readJsonObject, sendBadInput, sendJson, sendJsonBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { NotionBundleError } from "../../../application/notion-bundle.ts";
import { NotionImportRequestError, importNotionBundle } from "../../../application/notion-import.ts";

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

/** Import endpoints (`imports.notion`). */
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
    const { request, response, services, env } = ctx;
    if (!services) { sendUnavailable(response); return; }

    const bodyResult = await readJsonObject(request, MAX_NOTION_IMPORT_BYTES);
    if (bodyResult.ok === false) { sendJsonBodyError(response, request, bodyResult); return; }

    const apply = readApplyFlag(bodyResult.value.apply);
    if (apply === null) { sendBadInput(response, "`apply` must be a boolean when present."); return; }
    if (!("bundle" in bodyResult.value)) { sendBadInput(response, "A `bundle` object is required."); return; }

    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const report = await importNotionBundle({
        actorId,
        bundle: bodyResult.value.bundle,
        apply,
        deps: services,
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
});

export const IMPORT_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(IMPORT_ROUTE_HANDLERS));

export async function handleImportRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = IMPORT_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
