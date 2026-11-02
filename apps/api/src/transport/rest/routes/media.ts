import type { RestRouteContext, RestRouteHandler } from "./context.ts";
import {
  authenticatedActorId,
  decodeUserId,
  parseInteger,
  readRawImageBody,
  sendBadInput,
  sendJson,
  sendRawImageBodyError,
  sendServiceError,
  sendUnauthenticated,
  sendUnavailable,
} from "../http.ts";
import {
  MEDIA_PAGE_SIZE,
  MEDIA_PAGE_SIZE_MAX,
  MediaAssetInUseError,
  MediaAssetNotFoundError,
  MediaInputError,
} from "../../../application/media-assets.ts";
import { MediaStorageUnavailableError } from "../../../infrastructure/media-storage.ts";

/** The answer when media is not configured: the same one the upload route gives. */
function sendMediaUnconfigured(response: RestRouteContext["response"]): void {
  sendJson(response, 503, {
    error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "Image uploads are not configured for this deployment." },
  });
}

/** Private media reads and uploads (`media.item`, `me.media`, `me.media.item`). */
const MEDIA_ROUTE_HANDLERS: Readonly<Record<string, RestRouteHandler>> = Object.freeze({
  "media.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, mediaAssets, routeParams } = ctx;
    if (!mediaAssets) { sendUnavailable(response); return; }
    const id = decodeUserId(routeParams.id);
    if (!id) {
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
      return;
    }
    try {
      const media = await mediaAssets.getPublic({ id });
      const etag = `"${media.sha256}"`;
      const cacheHeaders = {
        "content-type": media.contentType,
        "content-length": String(media.byteSize),
        "cache-control": "public, max-age=31536000, immutable",
        "etag": etag,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      };
      if (request.headers["if-none-match"]?.split(",").map((value) => value.trim()).includes(etag)) {
        response.writeHead(304, { "cache-control": cacheHeaders["cache-control"], etag });
        response.end();
      } else {
        response.writeHead(200, cacheHeaders);
        response.end(media.bytes);
      }
    } catch (error: unknown) {
      if (error instanceof MediaAssetNotFoundError) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
      } else if (error instanceof MediaStorageUnavailableError) {
        sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media service is temporarily unavailable." } });
      } else {
        sendServiceError(response, error);
      }
    }
  },
  /**
   * `POST /api/v1/me/media` — upload, and `GET` — the author's own library.
   *
   * One path, because they are the same collection seen from two directions, and
   * splitting them would put the "is media configured at all" answer in two
   * places that could disagree.
   */
  "me.media": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, mediaAssets } = ctx;
    if (!services) { sendUnavailable(response); return; }
    if (!mediaAssets) { sendMediaUnconfigured(response); return; }
    if (request.method === "GET") {
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return; }
        const limit = parseInteger(ctx.url.searchParams, "limit", MEDIA_PAGE_SIZE, 1, MEDIA_PAGE_SIZE_MAX);
        if (limit === null) {
          sendBadInput(response, `limit must be a whole number between 1 and ${MEDIA_PAGE_SIZE_MAX}.`);
          return;
        }
        const data = await mediaAssets.listLibrary({
          ownerId: actorId,
          cursor: ctx.url.searchParams.get("cursor"),
          limit,
        });
        sendJson(response, 200, { data });
      } catch (error: unknown) {
        if (error instanceof MediaInputError) {
          sendJson(response, 400, { error: { code: error.code, message: error.message } });
        } else {
          sendServiceError(response, error);
        }
      }
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const body = await readRawImageBody(request);
      if (body.ok === false) {
        sendRawImageBodyError(response, body);
        return;
      }
      const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
      const asset = await mediaAssets.upload({ ownerId: actorId, bytes: body.bytes, contentType });
      sendJson(response, 201, { data: asset });
    } catch (error: unknown) {
      if (error instanceof MediaInputError) {
        sendJson(response, 400, { error: { code: error.code, message: error.message } });
      } else if (error instanceof MediaStorageUnavailableError) {
        sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media service is temporarily unavailable." } });
      } else {
        sendServiceError(response, error);
      }
    }
  },
  /**
   * `DELETE /api/v1/me/media/:id` — delete one unused asset (ADR 0022).
   *
   * The reference check happens in the service, against the current content, and
   * a refusal carries the works that use the image: "no" without the reason is a
   * support ticket, not an answer.
   */
  "me.media.item": async (ctx: RestRouteContext): Promise<void> => {
    const { request, response, services, env, mediaAssets, routeParams } = ctx;
    if (!services) { sendUnavailable(response); return; }
    if (!mediaAssets) { sendMediaUnconfigured(response); return; }
    if (request.headers["content-length"] || request.headers["transfer-encoding"]) {
      sendBadInput(response, "This endpoint takes no request body.");
      return;
    }
    const id = decodeUserId(routeParams.id);
    if (!id) {
      // The same 404 for "not yours" and "not there", so the endpoint cannot be
      // used to discover which assets exist.
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
      return;
    }
    try {
      const actorId = await authenticatedActorId(request, services, env);
      if (!actorId) { sendUnauthenticated(response); return; }
      const data = await mediaAssets.deleteAsset({ ownerId: actorId, id });
      sendJson(response, 200, { data });
    } catch (error: unknown) {
      if (error instanceof MediaAssetInUseError) {
        sendJson(response, 409, {
          error: {
            code: error.code,
            message: error.message,
            details: { referencedBy: error.referencedBy },
          },
        });
      } else if (error instanceof MediaAssetNotFoundError) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
      } else if (error instanceof MediaStorageUnavailableError) {
        sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The stored image could not be deleted." } });
      } else {
        sendServiceError(response, error);
      }
    }
  },
});

export const MEDIA_ROUTE_IDS: readonly string[] = Object.freeze(Object.keys(MEDIA_ROUTE_HANDLERS));

export async function handleMediaRoutes(ctx: RestRouteContext): Promise<boolean> {
  const handler = MEDIA_ROUTE_HANDLERS[ctx.routeId ?? ""];
  if (!handler) return false;
  await handler(ctx);
  return true;
}
