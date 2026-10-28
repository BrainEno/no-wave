# REST–GraphQL Contract Parity Audit

- Audit date: 2026-10-27
- Baseline: the former GraphQL schema and resolvers in `apps/api/src/transport/graphql/schema.ts`, as they existed during the 2026-10-27 migration review
- Status: historical migration record only. The live GraphQL schema/runtime, `/graphql` route, and schema-parity test have been removed after the Web public-content client migrated to REST.
- Rule used for this audit: an endpoint was marked complete only when its behavior, authorization, inputs, and return fields had a reviewed REST equivalent and tests; a similarly named route alone was not considered parity.
- The current public REST content API accepts `zh-CN`, `zh-TW`, and `en`; unsupported locale values fail validation.

## Field-level contracts

### `AuthorProfile`

GraphQL fields: `userId`, `displayName`, `bio`, `avatarUrl`, `websiteUrl`, `locale`, `createdAt`, `updatedAt`, `followerCount`, `followingCount`, and `isFollowing`.

REST profile/follow/search/follower/following responses must pass through the complete profile object returned by the application service. Reads that accept an optional bearer token derive viewer-specific `isFollowing` from a verified, non-revoked session; they must not hard-code `viewerId: null`. Authenticated follow/unfollow return the target's complete profile after the write. Contract tests assert every field.

### `Article`

GraphQL fields: `id`, `authorId`, `slug`, `workType`, `status`, `locale`, `title`, `summary`, `contentBlocks`, `contentBlocksVersion`, `createdAt`, `updatedAt`, `publishedAt`, `author`, `categories`, and `tags`.

The database article mapper intentionally supplies scalar/content fields only; the former GraphQL `Article` field resolvers hydrated `author`, `categories`, and `tags`. The REST implementation enriches all article-producing routes (public reads, author/category/tag lists, liked/related articles, current-user article lists, create, and update). REST represents `contentBlocks` as a JSON array, while the legacy GraphQL schema serializes it as a JSON string; `contentBlocksVersion` is shared by both transports. Version 0 retains the original plain-text block contract; version 1 adds application-owned inline text runs, supported marks, and safe HTTP(S) or root-relative links. The semantic data must round-trip without loss.

### `ArticleComment`

GraphQL fields: `id`, `articleId`, `authorId`, `parentCommentId`, `content`, `contentBlocks`, `contentBlocksVersion`, `createdAt`, `updatedAt`, `author`, and `replies`.

Comment REST responses include `author` (nullable when no profile exists), recursive `replies`, nullable `contentBlocks`, and `contentBlocksVersion`. Version 0 keeps the existing trimmed plain-text `content` and a null blocks value. Version 1 stores paragraph-only application content blocks plus an exactly matching plain-text fallback in `content`; the REST write boundary accepts either `contentBlocks` or serialized Lexical `editorState`, never both. This audit documented the transitional GraphQL representation at the time; the live REST comment contract is the active API. Delete preserves the prior boolean outcome inside the standard REST data envelope.

### `ArticleLikeInfo`

Fields: `articleId`, `slug`, `likeCount`, `likedByViewer`. The REST GET operation accepts an optional valid viewer token; the PUT mutation takes the explicit `liked` state and is retry-safe. The legacy toggle mutation is deliberately not mirrored as a non-idempotent HTTP toggle; clients should use the explicit state endpoint after migration.

### `Taxonomy`, `Message`, `Conversation`, and `Notification`

Taxonomy fields are `id`, `kind`, `slug`, `name`, `description`, `locale`, `createdBy`, and `articleCount`. REST reads and mutations expose this full service contract. `POST /api/v1/tags` retains hashtag normalization and idempotent reuse; `POST /api/v1/taxonomies` creates a localized taxonomy; `DELETE /api/v1/taxonomies/:taxonomyId` remains creator-scoped and returns the original boolean outcome.

Message fields are `id`, `conversationId`, `senderId`, `body`, `createdAt`. Conversation fields are `id`, `createdBy`, `participantIds`, `createdAt`, `lastActivityAt`, `unreadCount`, and `lastMessage`. Notification fields are `id`, `eventKey`, `payload`, `createdAt`, and `readAt`; REST keeps `payload` as a JSON-serialized string for backward-compatible notification consumers. Conversation access is checked by the existing persistence service, message sends derive `senderId` from JWT and require `Idempotency-Key`, and inbox/read-state operations are scoped by the verified recipient identity. Message history preserves the existing latest-window, oldest-first ordering and validates that `before` belongs to the same conversation.

## Operation-by-operation inventory

| GraphQL operation | REST equivalent | Status / notes |
|---|---|---|
| Query `health` | `GET /api/v1/health` | Complete |
| Query `viewer` | `GET /api/v1/me` | Complete; returns stable authenticated `id` |
| Query `viewerProfile(locale)` | `GET /api/v1/me/profile?locale=` | Complete; JWT-derived owner |
| Query `authorProfile(userId, locale)` | `GET /api/v1/authors/:userId?locale=` | Complete; optional viewer state preserved |
| Query `searchUsers(query, locale, limit)` | `GET /api/v1/users?query=&locale=&limit=` | Complete; required query and complete profile fields |
| Query `followers(userId, locale, limit)` | `GET /api/v1/users/:userId/followers?locale=&limit=` | Complete; viewer-aware profiles |
| Query `following(userId, locale, limit)` | `GET /api/v1/users/:userId/following?locale=&limit=` | Complete; viewer-aware profiles |
| Query `articles(locale, query, limit, offset)` | `GET /api/v1/articles` | Complete; enriched Article fields |
| Query `likedArticles(locale, limit)` | `GET /api/v1/me/liked-articles` | Complete; authenticated; enriched Article fields |
| Query `relatedArticles(slug, locale, limit)` | `GET /api/v1/articles/:slug/related` | Complete; enriched Article fields |
| Query `article(slug, locale)` | `GET /api/v1/articles/:slug` | Complete; enriched Article fields |
| Query `articleLikeInfo(slug, locale)` | `GET /api/v1/articles/:slug/like` | Complete; optional viewer |
| Query `articleComments(slug, locale, limit)` | `GET /api/v1/articles/:slug/comments` | Complete; nested author/replies are retained |
| Query `taxonomies(kind, locale, query, limit, offset)` | `GET /api/v1/categories`, `GET /api/v1/tags` | Read equivalent; fixed resource kind per route |
| Query `taxonomy(kind, slug, locale)` | `GET /api/v1/categories/:slug`, `GET /api/v1/tags/:slug` | Read equivalent |
| Query `taxonomyArticles(kind, slug, locale, limit, offset)` | `GET /api/v1/categories/:slug/articles`, `GET /api/v1/tags/:slug/articles` | Complete; enriched Article fields |
| Query `myArticles(locale, limit)` | `GET /api/v1/me/articles` | Complete; authenticated; enriched Article fields |
| Query `conversationMessages(conversationId, limit, before)` | `GET /api/v1/conversations/:conversationId/messages?limit=&before=` | Complete; JWT-derived membership, same-conversation cursor and oldest-first latest window |
| Query `conversations(limit)` | `GET /api/v1/conversations?limit=` | Complete; viewer-scoped list preserves all Conversation fields |
| Query `notifications(limit)` | `GET /api/v1/me/notifications?limit=` | Complete; recipient-scoped; payload remains a JSON string |
| Query `unreadNotificationCount` | `GET /api/v1/me/notifications/unread-count` | Complete; recipient-scoped count |
| Mutation `createArticle` | `POST /api/v1/articles` | Complete; owner derived from JWT; enriched response |
| Mutation `updateArticle` | `PUT /api/v1/articles/:articleId` | Complete; ownership checked; enriched response |
| Mutation `updateMyProfile` | `PUT /api/v1/me/profile` | Complete; owner derived from JWT |
| Mutation `followUser` / `unfollowUser` | `POST` / `DELETE /api/v1/users/:userId/follow` | Complete; return all AuthorProfile fields |
| Mutation `setArticleLike` | `PUT /api/v1/articles/:slug/like` | Complete; explicit state, retry-safe |
| Mutation `toggleArticleLike` | Same explicit state route | Intentionally not a 1:1 toggle route; migration must move clients to set-state semantics to avoid retry-driven inversion |
| Mutation `createArticleComment` | `POST /api/v1/articles/:slug/comments` | Complete; author and replies fields retained |
| Mutation `deleteArticleComment` | `DELETE /api/v1/comments/:commentId` | Complete; owner enforcement; boolean in REST envelope |
| Mutation `revokeCurrentSession` | `DELETE /api/v1/me/session` | Complete; revoke the verified JWT `jti` until its expiry |
| Mutation `createTag` | `POST /api/v1/tags` | Complete; strict body, JWT creator, existing normalization and idempotent reuse |
| Mutation `createTaxonomy` | `POST /api/v1/taxonomies` | Complete; `zh-CN` contract and creator identity from JWT |
| Mutation `deleteTaxonomy` | `DELETE /api/v1/taxonomies/:taxonomyId` | Complete; preserves creator authorization and boolean result |
| Mutation `createConversation` | `POST /api/v1/conversations` | Complete; actor is included by persistence and cannot be spoofed in body |
| Mutation `updateConversationParticipants` | `PATCH /api/v1/conversations/:conversationId/participants` | Complete; persistence enforces creator/member rules and full Conversation is returned |
| Mutation `deleteConversation` | `DELETE /api/v1/conversations/:conversationId` | Complete; creator/member authorization remains in persistence |
| Mutation `markConversationAsRead` | `PUT /api/v1/conversations/:conversationId/read` | Complete; only current participant's read state is changed |
| Mutation `sendMessage` | `POST /api/v1/conversations/:conversationId/messages` | Complete; sender from JWT, `Idempotency-Key` header, persistence/outbox transaction preserved |
| Mutation `markNotificationRead` | `PUT /api/v1/me/notifications/:notificationId/read` | Complete; recipient-scoped; missing/other-user rows remain `null` |
| Mutation `markAllNotificationsRead` | `POST /api/v1/me/notifications/read-all` | Complete; returns changed-row count for authenticated recipient |

## JWT audit summary

The verifier requires `HS256`, the application-specific `typ: application/vnd.bot-thk.access+jwt`, issuer, audience, `iat`, `exp`, `sub`, and `jti`; rejects non-canonical compact-token segments and unsupported critical headers; caps access-token TTL to 900 seconds by default; and supports `AUTH_JWT_MAX_TTL_SECONDS` (60–86400 seconds). Durable revocation checks fail closed. This is a private application profile, not RFC 9068/OAuth conformance: it uses a shared HS256 key and does not require `client_id` or implement an OAuth authorization server.

The independent API now has REST-only registration, password login, rotating refresh and logout endpoints; these are new API capabilities rather than GraphQL parity mappings. Email verification, account recovery, browser storage/cookie/CSRF policy, broader abuse protection, signing-key rotation and deployment remain open. See [API authentication](../architecture/api-authentication.md); do not mark the account system production-ready solely because token issuance is implemented.

## Migration closeout — 2026-10-28

The former GraphQL transport has been removed after the Web client migration. This document remains for traceability of the former operation and field inventory; it is not executable code and must not be treated as a runtime dependency. Current regression protection resides in the REST handler tests, persistence adapter contracts, identity/integration tests, route smoke tests, and the required CI aggregate. The REST public-content locale contract is `zh-CN`, `zh-TW`, and `en`. The former `toggleArticleLike` behavior intentionally maps to idempotent `PUT liked` state-setting semantics.

