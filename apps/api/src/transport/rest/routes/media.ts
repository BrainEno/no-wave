import type { RestRouteContext } from "./context.ts";
import { authenticatedActorId, decodeUserId, readRawImageBody, sendJson, sendRawImageBodyError, sendServiceError, sendUnauthenticated, sendUnavailable } from "../http.ts";
import { MediaAssetNotFoundError } from "../../../application/media-assets.ts";
import { MediaStorageUnavailableError } from "../../../infrastructure/media-storage.ts";
import { MediaUploadInputError } from "../../../application/media-assets.ts";

/** Private media reads and uploads (`media.item`, `me.media`). */
export async function handleMediaRoutes(ctx: RestRouteContext): Promise<boolean> {
  const { request, response, services, env, mediaAssets, routeParams, routeId } = ctx;

    if (routeId === "media.item") {
      if (!mediaAssets) { sendUnavailable(response); return true; }
      const id = decodeUserId(routeParams.id);
      if (!id) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "The requested media asset was not found." } });
        return true;
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
      return true;
    }

    if (routeId === "me.media") {
      if (!services) { sendUnavailable(response); return true; }
      if (!mediaAssets) {
        sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "Image uploads are not configured for this deployment." } });
        return true;
      }
      try {
        const actorId = await authenticatedActorId(request, services, env);
        if (!actorId) { sendUnauthenticated(response); return true; }
        const body = await readRawImageBody(request);
        if (body.ok === false) {
          sendRawImageBodyError(response, body);
          return true;
        }
        const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
        const asset = await mediaAssets.upload({ ownerId: actorId, bytes: body.bytes, contentType });
        sendJson(response, 201, { data: asset });
      } catch (error: unknown) {
        if (error instanceof MediaUploadInputError) {
          sendJson(response, 400, { error: { code: error.code, message: error.message } });
        } else if (error instanceof MediaStorageUnavailableError) {
          sendJson(response, 503, { error: { code: "MEDIA_STORAGE_UNAVAILABLE", message: "The media service is temporarily unavailable." } });
        } else {
          sendServiceError(response, error);
        }
      }
      return true;
    }

  return false;
}
