/**
 * `@bot-thk/web-http` — the framework-neutral HTTP seam (ADR 0012, Phase 2).
 *
 * Everything here is written against standard `Request`/`Response`/`Headers` and
 * takes explicit inputs, so the same implementation serves the Next.js route
 * handlers, the React Router resource routes and its own contract tests. No
 * framework import is allowed in this package.
 */
export { AUTH_ACTIONS, handleAuthRequest, isAuthAction, type AuthAction } from "./auth.ts";
export { apiUrl, readPayload, type ApiProxyConfig, type FetchImpl } from "./api.ts";
export {
  readLimitedBytes,
  readLimitedJson,
  readLimitedStream,
  type BytesBodyResult,
  type JsonBodyResult,
  type StreamReadFailure,
} from "./body.ts";
export {
  ACCESS_COOKIE_PATH,
  REFRESH_COOKIE_PATH,
  accessTokenFrom,
  clearedTokenCookieHeaders,
  isSecureRequest,
  readCookie,
  refreshTokenFrom,
  serializeCookie,
  tokenCookieHeaders,
} from "./cookies.ts";
export { forwardAuthoringRequest, type ForwardMethod } from "./forward.ts";
export { NO_STORE, errorResponse, isRecord, jsonResponse, safeApiError } from "./http.ts";
export {
  MEDIA_ID_PATTERN,
  MEDIA_IMMUTABLE_CACHE,
  MEDIA_MAX_BYTES,
  MEDIA_UPLOAD_TYPES,
  handleMediaUploadRequest,
  handlePublicMediaRequest,
} from "./media.ts";
export {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  isSameOriginMutation,
  isTokenEnvelope,
  safeRedirectPath,
  setIdempotencyKeyHeader,
  tokenMaxAge,
  type TokenSet,
} from "./policy.ts";
export type { CookieOptions } from "./cookies.ts";
