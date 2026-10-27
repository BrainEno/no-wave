# REST–GraphQL Contract Parity Audit

- Audit date: 2026-10-27
- Baseline: the current GraphQL schema and resolvers in `apps/api/src/transport/graphql/schema.ts`
- Rule: an endpoint is marked complete only when its behavior, authorization, inputs, and return fields have a REST equivalent and tests. The existence of a similarly named route alone is not parity.
- The public REST API intentionally accepts only `zh-CN`; this is an approved contract change documented in ADR 0006, not accidental field/operation parity.

## Field-level contracts

### `AuthorProfile`

GraphQL fields: `userId`, `displayName`, `bio`, `avatarUrl`, `websiteUrl`, `locale`, `createdAt`, `updatedAt`, `followerCount`, `followingCount`, and `isFollowing`.

REST profile/follow/search/follower/following responses must pass through the complete profile object returned by the application service. Reads that accept an optional bearer token derive viewer-specific `isFollowing` from a verified, non-revoked session; they must not hard-code `viewerId: null`. Authenticated follow/unfollow return the target's complete profile after the write. Contract tests assert every field.

### `Article`

GraphQL fields: `id`, `authorId`, `slug`, `workType`, `status`, `locale`, `title`, `summary`, `contentBlocks`, `createdAt`, `updatedAt`, `publishedAt`, `author`, `categories`, and `tags`.

The database article mapper intentionally supplies the scalar/content fields only; GraphQL's `Article` field resolvers hydrate `author`, `categories`, and `tags`. REST must do the equivalent enrichment for all article-producing routes (public reads, author/category/tag lists, liked/related articles, current-user article lists, create, and update). REST represents `contentBlocks` as a JSON array, while the legacy GraphQL schema serializes it as a JSON string; this is an explicit transport representation difference, not a missing field, and the semantic data must round-trip without loss.

### `ArticleComment`

GraphQL fields: `id`, `articleId`, `authorId`, `parentCommentId`, `content`, `createdAt`, `updatedAt`, `author`, and `replies`.

Comment REST responses must include `author` (nullable when no profile exists) and recursively include `replies`; this mirrors the GraphQL resolver rather than dropping the nested author field. Delete preserves the GraphQL boolean outcome inside the standard REST data envelope.

### `ArticleLikeInfo`

Fields: `articleId`, `slug`, `likeCount`, `likedByViewer`. The REST GET operation accepts an optional valid viewer token; the PUT mutation takes the explicit `liked` state and is retry-safe. The legacy toggle mutation is deliberately not mirrored as a non-idempotent HTTP toggle; clients should use the explicit state endpoint after migration.

### `Taxonomy`, `Message`, `Conversation`, and `Notification`

Taxonomy fields are `id`, `kind`, `slug`, `name`, `description`, `locale`, `createdBy`, and `articleCount`. Existing taxonomy REST reads return these service objects; taxonomy mutations remain pending.

Message fields are `id`, `conversationId`, `senderId`, `body`, `createdAt`. Conversation fields are `id`, `createdBy`, `participantIds`, `createdAt`, `lastActivityAt`, `unreadCount`, and `lastMessage`. Notification fields are `id`, `eventKey`, `payload`, `createdAt`, and `readAt`; GraphQL serializes `payload` to a JSON string. These resource groups do not yet have REST parity and must be added with equivalent membership/recipient authorization, cursor behavior, idempotency, outbox interaction and complete fields.

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
| Query `conversationMessages(conversationId, limit, before)` | — | Missing; preserve cursor semantics and oldest-first window |
| Query `conversations(limit)` | — | Missing; must return last-activity, unread count and last-message fields |
| Query `notifications(limit)` | — | Missing; recipient-scoped; JSON-string payload contract |
| Query `unreadNotificationCount` | — | Missing |
| Mutation `createArticle` | `POST /api/v1/articles` | Complete; owner derived from JWT; enriched response |
| Mutation `updateArticle` | `PUT /api/v1/articles/:articleId` | Complete; ownership checked; enriched response |
| Mutation `updateMyProfile` | `PUT /api/v1/me/profile` | Complete; owner derived from JWT |
| Mutation `followUser` / `unfollowUser` | `POST` / `DELETE /api/v1/users/:userId/follow` | Complete; return all AuthorProfile fields |
| Mutation `setArticleLike` | `PUT /api/v1/articles/:slug/like` | Complete; explicit state, retry-safe |
| Mutation `toggleArticleLike` | Same explicit state route | Intentionally not a 1:1 toggle route; migration must move clients to set-state semantics to avoid retry-driven inversion |
| Mutation `createArticleComment` | `POST /api/v1/articles/:slug/comments` | Complete; author and replies fields retained |
| Mutation `deleteArticleComment` | `DELETE /api/v1/comments/:commentId` | Complete; owner enforcement; boolean in REST envelope |
| Mutation `revokeCurrentSession` | `DELETE /api/v1/me/session` | Complete; revoke the verified JWT `jti` until its expiry |
| Mutation `createTag` | — | Missing; preserve hashtag normalization and idempotent reuse |
| Mutation `createTaxonomy` | — | Missing; preserve creator ownership and localized labels |
| Mutation `deleteTaxonomy` | — | Missing; preserve creator authorization and deletion behavior |
| Mutation `createConversation` | — | Missing |
| Mutation `updateConversationParticipants` | — | Missing; preserve membership/owner rules and return updated Conversation fields |
| Mutation `deleteConversation` | — | Missing |
| Mutation `markConversationAsRead` | — | Missing |
| Mutation `sendMessage` | — | Missing; server-derived sender, idempotency key and transactional outbox must be preserved |
| Mutation `markNotificationRead` | — | Missing; recipient-scoped |
| Mutation `markAllNotificationsRead` | — | Missing; return changed-row count |

## JWT audit summary

The verifier now requires `HS256`, the application-specific `typ: application/vnd.bot-thk.access+jwt`, issuer, audience, `iat`, `exp`, `sub`, and `jti`; rejects non-canonical compact-token segments and unsupported critical header parameters; caps access-token TTL to 900 seconds by default; and supports `AUTH_JWT_MAX_TTL_SECONDS` (60–86400 seconds). The API checks session revocation and fails closed if durable revocation state cannot be checked. This is a private application profile, not a claim of full RFC 9068 conformance: the repository does not implement token issuance/refresh, the verifier only uses a shared HS256 key, and it does not require RFC 9068 `client_id`. If the product later adopts OAuth/JWT access-token interoperability, implement that profile end-to-end (including compatible signing/key-discovery and claims) instead of reusing the private type marker.

The repository does not yet implement the sign-in/token-issuance or refresh-token flow. A future issuer must emit matching access-token claims and use a cryptographically random server-managed secret of at least 32 bytes. Refresh-token rotation, CSRF/cookie policy (if cookies are used), abuse throttling, recovery flow, and secret rotation/operational runbooks remain separate acceptance items; do not mark the whole login system production-ready solely because JWT verification is strict.

## Acceptance before GraphQL removal

- Every operation above marked missing has a reviewed REST contract and authorization regression tests.
- Every exposed object retains the fields listed in its GraphQL type unless a representation change is explicitly documented.
- A machine-readable or test-enforced contract check compares the GraphQL schema inventory with the REST parity inventory.
- Web callers have migrated; only then may GraphQL/Yoga and its configuration be removed.
