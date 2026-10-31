/**
 * `@bot-thk/web-http` — the framework-neutral HTTP seam (ADR 0012, Phase 2).
 *
 * Everything here is written against standard `Request`/`Response`/`Headers` and
 * takes explicit inputs, so the same implementation serves the Next.js route
 * handlers, the React Router resource routes and its own contract tests. No
 * framework import is allowed in this package.
 */
export {
  AUTH_ACTIONS,
  IDENTITY_ACTIONS,
  handleAuthRequest,
  isAuthAction,
  isIdentityAction,
  type AuthAction,
  type IdentityAction,
} from "./auth.ts";
export { handleAccountEmailVerificationRequest, handleAccountPasswordChangeRequest } from "./account.ts";
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
  SESSION_COOKIE_PATH,
  accessTokenFrom,
  clearedTokenCookieHeaders,
  hasUsableSession,
  isSecureRequest,
  readCookie,
  refreshTokenFrom,
  serializeCookie,
  sessionMarkerFrom,
  tokenCookieHeaders,
} from "./cookies.ts";
export { forwardAuthoringRequest, type ForwardMethod } from "./forward.ts";
export { NO_STORE, errorResponse, isRecord, jsonResponse, safeApiError } from "./http.ts";
export {
  AUTHORING_ARTICLES_LIMIT,
  AUTHORING_ARTICLE_ID_PATTERN,
  AUTHORING_BODY_MAX_BYTES,
  AUTHORING_DEFAULT_LOCALE,
  AUTHORING_LOCALES,
  authoringArticlePath,
  authoringArticlesPath,
  authoringDeletedArticlesPath,
  authoringRestoreArticlePath,
  handleAuthoringArticleRequest,
  handleAuthoringArticlesRequest,
  handleAuthoringDeletedArticlesRequest,
  handleAuthoringRestoreRequest,
  handleAuthoringSessionRequest,
  isAuthoringLocale,
} from "./authoring.ts";
export {
  COMMENT_BODY_MAX_BYTES,
  COMMENT_DEFAULT_LOCALE,
  COMMENT_LOCALES,
  COMMENT_PAGE_LIMIT,
  COMMENT_SLUG_PATTERN,
  commentsRequestPath,
  handleArticleCommentsRequest,
  isCommentLocale,
} from "./comments.ts";
export {
  NOTIFICATION_ID_PATTERN,
  NOTIFICATIONS_LIMIT,
  handleNotificationReadRequest,
  handleNotificationsReadAllRequest,
  handleNotificationsRequest,
  handleNotificationsUnreadCountRequest,
  notificationReadPath,
  notificationsPath,
  notificationsReadAllPath,
  notificationsUnreadCountPath,
} from "./notifications.ts";
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
  SESSION_MARKER_COOKIE,
  isSameOriginMutation,
  isTokenEnvelope,
  safeRedirectPath,
  setIdempotencyKeyHeader,
  tokenMaxAge,
  type TokenSet,
} from "./policy.ts";
export type { CookieOptions } from "./cookies.ts";
