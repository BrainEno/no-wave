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
export {
  handleAccountEmailChangeRequest,
  handleAccountEmailVerificationRequest,
  handleAccountPasswordChangeRequest,
  handleAccountSessionsRequest,
  handleAccountSessionEndRequest,
  handleAccountOtherSessionsEndRequest,
} from "./account.ts";
export {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAXIMUM_UPSTREAM_TIMEOUT_MS,
  UpstreamTimeoutError,
  apiUrl,
  readPayload,
  resolveUpstreamTimeoutMs,
  withUpstreamDeadline,
  type ApiProxyConfig,
  type FetchImpl,
} from "./api.ts";
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
export { parseRetryAfterSeconds } from "./retry-after.ts";
export {
  InMemoryRefreshCoordinator,
  refreshCoordinatorKey,
  type InMemoryRefreshCoordinatorOptions,
  type RefreshCoordinator,
  type RefreshOutcome,
} from "./refresh-coordinator.ts";
export { NO_STORE, errorResponse, isRecord, jsonResponse, safeApiError } from "./http.ts";
export {
  AUTHORING_ARTICLES_LIMIT,
  AUTHORING_ARTICLE_ID_PATTERN,
  AUTHORING_BODY_MAX_BYTES,
  AUTHORING_DEFAULT_LOCALE,
  AUTHORING_EXPECTED_ACTOR_HEADER,
  AUTHORING_EXPORT_MAX_WORKS,
  AUTHORING_LOCALES,
  AUTHORING_NOT_FORWARDED_HEADER,
  AUTHORING_NOTION_IMPORT_MAX_BYTES,
  AUTHORING_SLUG_PATTERN,
  authoringArticlePath,
  authoringArticlesPath,
  authoringDeletedArticlesPath,
  authoringNotionExportPath,
  authoringRestoreArticlePath,
  handleAuthoringArticleRequest,
  handleAuthoringArticlesRequest,
  handleAuthoringDeletedArticlesRequest,
  handleAuthoringNotionExportRequest,
  handleAuthoringNotionImportRequest,
  handleAuthoringRestoreRequest,
  handleAuthoringSessionRequest,
  isAuthoringLocale,
} from "./authoring.ts";
export {
  AUTHORING_PROFILE_BODY_MAX_BYTES,
  AUTHORING_PROFILE_DEFAULT_LOCALE,
  AUTHORING_PROFILE_PATH,
  authoringProfilePath,
  handleAuthoringProfileRequest,
} from "./profile.ts";
export {
  FEATURED_CANDIDATES_LIMIT,
  authoringFeaturedCandidatesPath,
  authoringFeaturedPath,
  handleAuthoringFeaturedCandidatesRequest,
  handleAuthoringFeaturedRequest,
} from "./curate.ts";
export {
  COMMENT_BODY_MAX_BYTES,
  COMMENT_DEFAULT_LOCALE,
  COMMENT_ID_PATTERN,
  COMMENT_LOCALES,
  COMMENT_PAGE_LIMIT,
  COMMENT_PAGE_LIMIT_MAX,
  COMMENT_SLUG_PATTERN,
  commentsRequestPath,
  handleArticleCommentsRequest,
  handleCommentUpdateRequest,
  isCommentLocale,
} from "./comments.ts";
export {
  articleViewPath,
  handleArticleViewRequest,
} from "./views.ts";
export {
  LIKE_BODY_MAX_BYTES,
  LIKE_DEFAULT_LOCALE,
  LIKE_LOCALES,
  LIKE_SLUG_PATTERN,
  handleArticleLikeRequest,
  isLikeLocale,
  likeRequestPath,
  parseLikeBody,
} from "./likes.ts";
export {
  FOLLOW_DEFAULT_LOCALE,
  FOLLOW_LOCALES,
  FOLLOW_TARGET_MAX_LENGTH,
  followRequestPath,
  handleAuthorProfileRequest,
  handleUserFollowRequest,
  isFollowLocale,
  isFollowTargetId,
} from "./follows.ts";
export {
  FEED_DEFAULT_LIMIT,
  FEED_DEFAULT_LOCALE,
  FEED_LOCALES,
  FEED_MAX_LIMIT,
  FEED_MAX_OFFSET,
  feedRequestPath,
  handleFeedRequest,
  isFeedLocale,
  parseFeedInteger,
} from "./feed.ts";
export {
  CONVERSATIONS_MAX_LIMIT,
  CONVERSATION_ID_PATTERN,
  CONVERSATION_MAX_PARTICIPANTS,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  INBOX_DEFAULT_LIMIT,
  MESSAGES_DEFAULT_LIMIT,
  MESSAGE_BODY_MAX_CHARS,
  MESSAGE_WRITE_MAX_BYTES,
  MESSAGING_EXPECTED_ACTOR_HEADER,
  conversationPath,
  conversationReadPath,
  handleConversationMessagesRequest,
  handleConversationReadRequest,
  handleConversationRequest,
  handleInboxRequest,
  handleSendMessageRequest,
  handleStartConversationRequest,
  inboxPath,
  isUsableIdempotencyKey,
  messagesPath,
  parseLimit,
  parseMessageBody,
  parseParticipantIds,
} from "./messages.ts";
export {
  NOTIFICATION_EXPECTED_ACTOR_HEADER,
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
  handleMediaDeleteRequest,
  handleMediaLibraryRequest,
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
