import { apiUrl, type ApiProxyConfig, type FetchImpl } from "./api.ts";
import { readLimitedBytes, readLimitedStream } from "./body.ts";
import { errorResponse } from "./http.ts";
import { isSameOriginMutation } from "./policy.ts";
import { forwardAuthoringRequest } from "./forward.ts";

/**
 * Media request/response adapter (ADR 0012, Phase 5).
 *
 * Both halves of media traffic go through the browser-facing app rather than to
 * the storage bucket directly, and that is a security property, not a
 * convenience: the object store is private, its credentials never leave the API,
 * and the app's job is to relay bytes while normalizing everything else —
 * cache policy, content type, size ceiling, error surface.
 *
 * Like the rest of this package, nothing here imports a framework: Next.js route
 * handlers, React Router resource routes and the contract tests call the same
 * functions with the same inputs.
 */

/** Ceiling for both upload and download; matches the API's normalized WebP limit. */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Media ids are UUIDs. Validating the shape before proxying keeps the API from
 * being asked about arbitrary paths, and makes `/api/media/<garbage>` a local
 * 404 instead of an upstream round trip.
 */
export const MEDIA_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Uploads are normalized to WebP by the API; only these inputs are accepted. */
export const MEDIA_UPLOAD_TYPES: readonly string[] = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

/**
 * Media objects are content-addressed by their SHA-256 (the API uses it as the
 * ETag), so a stored object never changes: immutable caching is correct here,
 * and `public` is correct because the same bytes are served to every visitor.
 */
export const MEDIA_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Only a well-formed content hash is forwarded; anything else would be a cache-poisoning vector. */
const ETAG_PATTERN = /^"[0-9a-f]{64}"$/i;

/**
 * Serve a stored media object.
 *
 * The bytes are read through a bounded reader rather than piped straight to the
 * client: an upstream that misbehaves (or a compromised one) cannot make this
 * process buffer an unbounded response.
 */
export async function handlePublicMediaRequest(
  request: Request,
  id: string,
  config: ApiProxyConfig = {},
): Promise<Response> {
  if (!MEDIA_ID_PATTERN.test(id)) {
    return errorResponse("NOT_FOUND", "The requested media asset was not found.", 404);
  }

  const base = config.apiBaseUrl;
  if (!base) {
    return errorResponse("SERVICE_UNAVAILABLE", "The API service is not configured.", 503);
  }

  const headers = new Headers({ accept: "image/webp" });
  const incomingEtag = request.headers.get("if-none-match");
  if (incomingEtag && ETAG_PATTERN.test(incomingEtag.trim())) headers.set("if-none-match", incomingEtag.trim());

  const fetchImpl: FetchImpl = config.fetchImpl ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchImpl(apiUrl(base, `api/v1/media/${encodeURIComponent(id)}`), {
      method: "GET",
      headers,
      cache: "no-store",
    });
  } catch {
    return errorResponse("SERVICE_UNAVAILABLE", "The media service could not be reached.", 502);
  }

  const etag = upstream.headers.get("etag");
  if (upstream.status === 304) {
    const response = new Response(null, { status: 304, headers: { "cache-control": MEDIA_IMMUTABLE_CACHE } });
    if (etag) response.headers.set("etag", etag);
    return response;
  }

  if (!upstream.ok) {
    return upstream.status === 404
      ? errorResponse("NOT_FOUND", "The requested media asset was not found.", 404)
      : errorResponse("MEDIA_STORAGE_UNAVAILABLE", "The media service is temporarily unavailable.", 503);
  }

  const declaredSize = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MEDIA_MAX_BYTES) {
    return errorResponse("MEDIA_STORAGE_UNAVAILABLE", "The media object exceeded the response limit.", 502);
  }

  const body = await readLimitedStream(upstream.body, MEDIA_MAX_BYTES);
  if (body.ok === false) {
    // Every bounded-read failure is an upstream problem here, not a client error:
    // the visitor asked for a valid object and the bytes came back unusable.
    const message = body.reason === "empty"
      ? "The media object has no response body."
      : body.reason === "unreadable"
      ? "The media object could not be read."
      : "The media object exceeded the response limit.";
    return errorResponse("MEDIA_STORAGE_UNAVAILABLE", message, 502);
  }

  const response = new Response(body.bytes, {
    status: 200,
    headers: {
      // Only the normalized type is passed through; anything else is served as a
      // download-safe octet stream so a stored object cannot be replayed as HTML.
      "content-type": upstream.headers.get("content-type") === "image/webp" ? "image/webp" : "application/octet-stream",
      "content-length": String(body.bytes.byteLength),
      "cache-control": MEDIA_IMMUTABLE_CACHE,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
  if (etag) response.headers.set("etag", etag);
  return response;
}

/**
 * Relay an image upload to the API.
 *
 * The access token lives in an `HttpOnly` cookie, so the browser cannot call the
 * API directly; `forwardAuthoringRequest` attaches it (and refreshes it once)
 * server-side. The Origin check and the size/content-type limits are enforced
 * *before* the body is read.
 */
export async function handleMediaUploadRequest(request: Request, config: ApiProxyConfig = {}): Promise<Response> {
  if (!isSameOriginMutation(request.url, request.headers.get("origin"), request.headers.get("host"))) {
    return errorResponse("ORIGIN_REJECTED", "The request origin was rejected.", 403);
  }

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!MEDIA_UPLOAD_TYPES.includes(contentType)) {
    return errorResponse("UNSUPPORTED_MEDIA_TYPE", "Only JPEG, PNG and WebP images are accepted.", 415);
  }

  const body = await readLimitedBytes(request, MEDIA_MAX_BYTES, "The image request body exceeds 8 MiB.");
  if (body.ok === false) return body.response;

  return forwardAuthoringRequest(request, "api/v1/me/media", "POST", config, body.bytes, contentType);
}
