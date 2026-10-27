# API Security and Persistence Foundation

This package is the API layer of the independent BOT THK rebuild. The previous project is a source of feature/behavior evidence, not a requirement to preserve its implementation. PostgreSQL is the only registered runtime provider. A composed SQLite adapter and some shared contract tests exist, but SQLite is not enabled as a runtime provider until its full acceptance gates pass; MongoDB remains planned.

## Runtime probes

- `GET /health` is a liveness probe and does not require persistence.
- `GET /ready` is a readiness probe: it returns `200` only when a configured persistence store passes its health check, otherwise `503` with a sanitized response. Both responses are non-cacheable.

## Versioned REST API

The standalone REST transport exposes public read endpoints and initial authenticated article-management endpoints alongside the transitional GraphQL runtime. All REST responses use JSON and `Cache-Control: no-store`.

- `GET /api/v1/health` — liveness probe.
- `GET /api/v1/articles?locale=zh-CN&query=&limit=20&offset=0` — published article search and pagination.
- `GET /api/v1/articles/:slug?locale=zh-CN` — one published article.
- `GET /api/v1/me/articles?locale=zh-CN&limit=50` — the authenticated actor's own drafts and published articles.
- `POST /api/v1/articles` — create an article as the authenticated actor.
- `PUT /api/v1/articles/:articleId` — update an article; ownership is checked against the authenticated actor.
- `GET /api/v1/authors/:userId?locale=zh-CN` — public author profile addressed by stable `userId`.
- `GET /api/v1/authors/:userId/articles?query=&limit=20&offset=0` — published articles for that author; the author filter runs in persistence before pagination.
- `GET /api/v1/categories?locale=zh-CN&query=&limit=100&offset=0` — localized category discovery and pagination.
- `GET /api/v1/categories/:slug?locale=zh-CN` — localized category detail.
- `GET /api/v1/categories/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles in a category.
- `GET /api/v1/tags?locale=zh-CN&query=&limit=100&offset=0` — localized public hashtag discovery and pagination.
- `GET /api/v1/tags/:slug?locale=zh-CN` — one localized hashtag, or `404 NOT_FOUND`.
- `GET /api/v1/tags/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles associated with a hashtag.

The versioned REST API accepts only `zh-CN`. Requests specifying `zh-TW`, `en`, or another locale return `400 BAD_USER_INPUT`; search terms are limited to 200 characters and limits are 1–100.
Article write requests require `Authorization: Bearer <JWT>` with a valid issuer, audience, expiry and `jti`; revoked sessions fail with `401 UNAUTHENTICATED`. The server derives `authorId`/`actorId` from the verified JWT and rejects client-supplied identity fields. Write bodies must use `Content-Type: application/json`, contain a JSON object, and fit within 2 MiB. `contentBlocks` is a JSON array at the REST boundary; only `zh-CN` is accepted. Create returns `201`, update returns `200`, and domain failures map to the documented sanitized status codes. Invalid query values return `400 BAD_USER_INPUT`, unknown article/category resources return `404 NOT_FOUND`, and missing persistence returns `503 SERVICE_UNAVAILABLE`. Domain errors thrown by application services map to stable REST statuses: `BAD_USER_INPUT` → 400, `FORBIDDEN` → 403, `NOT_FOUND` → 404, and `CONFLICT` / `IDEMPOTENCY_CONFLICT` → 409. The adapter does not forward domain exception text; unknown domain codes and unexpected exceptions return a generic `500 INTERNAL_SERVER_ERROR` response without internal details. Category article requests resolve the category before listing content, so unknown categories do not produce a misleading successful empty list.

## PostgreSQL setup

Set `DATABASE_PROVIDER=postgres` and `DATABASE_URL` to a developer-owned PostgreSQL database, then run:

```sh
pnpm --filter @bot-thk/api migrate
pnpm --filter @bot-thk/api start
```

Migrations are explicit release steps; API startup does not silently change the schema. Never run the migration command against production without a reviewed release plan and backup.

## Persistence API

- `createPostgresClient()` creates a postgres.js connection pool and validates the connection URL.
- `runMigrations(sql)` applies ordered SQL migrations under an advisory lock and records versions.
- `createPostgresStore(sql)` is the current infrastructure adapter.
- `src/application/persistence-ports.ts` defines the required domain-grouped adapter contract, and `src/application/services.ts` is the application-facing composition seam. Domain validation and errors live under `src/domain/`; PostgreSQL-specific queries, transactions, constraints and row mapping remain in `src/persistence/`.
- `DATABASE_PROVIDER` selects a registered adapter at startup. Currently only `postgres` is registered. `mongodb` and `sqlite` fail explicitly until their adapters pass the full provider acceptance gates; the application never silently falls back to PostgreSQL.
- Message writes require an existing conversation membership. Sender identity must come from the server-verified actor, never a client-supplied `senderId`.
- Reusing an idempotency key with a different payload fails with `IDEMPOTENCY_CONFLICT`.
- JWTs must include a unique, non-empty `jti`; the API checks that session ID against PostgreSQL on each authenticated request when persistence is configured, so revoked sessions fail closed. The `revokeCurrentSession` mutation records the current `jti` until the signed token's expiry.

GraphQL is retained temporarily during the approved staged migration only. The target architecture is REST-only; do not add new GraphQL operations, and remove the GraphQL transport and Yoga dependency after the remaining operations have REST equivalents and regression coverage. The transitional GraphQL API currently exposes public `articles`, `likedArticles`, `relatedArticles`, `article`, `articleLikeInfo`, `articleComments`, `taxonomies`, `taxonomyArticles`, `authorProfile`, `searchUsers`, `followers`, and `following` queries, authenticated `myArticles`, `createArticle`, `updateArticle`, `toggleArticleLike`, `setArticleLike`, `createArticleComment`, `deleteArticleComment`, `createTaxonomy`, `deleteTaxonomy`, `updateMyProfile`, `followUser`, and `unfollowUser` operations, plus authenticated `createConversation`, `conversations`, `conversationMessages`, `updateConversationParticipants`, `markConversationAsRead`, `deleteConversation`, `sendMessage`, `notifications`, `unreadNotificationCount`, `markNotificationRead`, `markAllNotificationsRead`, and `revokeCurrentSession` operations when a store is configured. Conversation lists are scoped to the authenticated actor and include participant IDs plus the latest message summary; message history is returned oldest-first within the requested latest-message window. Message reads check database membership; sends derive `senderId` from the verified JWT subject and commit the message with its outbox intent. The notification inbox is scoped to the verified JWT subject, and read-state updates include the recipient in the SQL predicate so another user cannot inspect or mark a notification. Unread counts and batch read operations are also scoped to the authenticated actor. Notification payloads are exposed as JSON-serialized strings. The reusable outbox dispatcher leases events with `FOR UPDATE SKIP LOCKED`, marks successful delivery, and schedules failed delivery for retry. A standalone `pnpm --filter @bot-thk/api worker:notifications` process converts `message.created` outbox events into durable inbox rows. Configure it under a process supervisor alongside the API (not inside the web request process). Optional settings are `OUTBOX_POLL_INTERVAL_MS` (default `1000`), `OUTBOX_BATCH_LIMIT` (default `25`), `OUTBOX_LEASE_SECONDS` (default `60`), and `OUTBOX_RETRY_DELAY_SECONDS` (default `30`). It requires `DATABASE_URL` and uses the same PostgreSQL store; no external push provider is configured, so this worker persists in-app notifications rather than sending web push/email. Do not advertise external push delivery or the entire messaging/notification feature set as production-ready until those pieces are complete.

### Outbox leases and worker rollout

- Each claim gets a new internal `lease_token`. Acknowledgement and retry require that token and a still-active lease; an expired, released or superseded claim cannot complete or postpone an event. A successful retry schedule releases the token. PostgreSQL checks expiry after acquiring the row lock; SQLite uses its write lock and database clock.
- `OUTBOX_BATCH_LIMIT` is the maximum number processed in one dispatch, but events are claimed **one at a time**, just before delivery. This avoids letting later events' leases expire while they wait behind a slow earlier event; it increases database round trips. Claims are not renewed automatically, so configure `OUTBOX_LEASE_SECONDS` longer than the expected maximum time for a single delivery and monitor slow/repeated attempts.
- Delivery is **at least once**, not exactly once. A worker can persist notifications and then crash or lose its lease before acknowledgement. The next worker may invoke delivery again; inbox writes deduplicate by recipient and event key. Any future external push consumer must provide its own idempotency and cannot assume a lease prevents side effects after expiry. Do not expose or log lease tokens.
- **Upgrade/rollback coordination:** stop and drain all old notification workers first. After an approved backup/release plan, apply the additive PostgreSQL migration `0010_outbox_lease_tokens` using the explicit migration command, then start only workers with the new code. Existing pending/delivered rows are preserved; previously leased rows become claimable when their existing `available_at` expires. Do not run old and new workers together: old workers can still acknowledge without a token. For rollback, stop all workers and assess the loss of fencing before restarting an older version; removing the column is not required for old code. No production migration is implied by this change.
- The current notification consumer resolves active participants at delivery time, requires the sender to remain active, and writes recipient notifications separately from conversation lifecycle changes. Removing a sender may leave an event retrying indefinitely, and membership changes or concurrent deletion can produce outdated/orphaned notifications. Recipient eligibility and atomic lifecycle handling remain open work; lease fencing does not solve these cases.

### Article persistence contract

Author profiles are stored with shared account-level avatar/website fields and per-locale display name/bio translations. User discovery supports localized display-name/ID search, following/follower lists, follower/following counts, and viewer-specific follow state. Follow and unfollow mutations derive the follower from JWT identity; a newly created follow writes an idempotent relationship and a durable `user.followed` notification in the same transaction; `updateMyProfile` derives the profile owner from the verified JWT. Published article results expose a nullable localized `author` profile when the owner has configured that locale. Articles are stored independently of the legacy MongoDB backend. Each article has one unique slug, author identity derived from verified JWT `sub`, draft/published state, and translated content rows keyed by `zh-TW` or `en`. Public list/detail queries return published content only; `myArticles` includes the authenticated owner's drafts. Article bodies are stored as validated JSON content blocks (`paragraph`, `heading`, `quote`, `list`, `image`, `code`). `contentBlocks` is a JSON-serialized string at the GraphQL boundary. Create/update operations enforce author ownership, reject duplicate slugs, and validate body shape before persistence. Category/tag records and their localized labels are persisted separately from articles. `createTag(name, locale)` supports user-created Unicode hashtags (including Traditional Chinese), strips a leading `#`, normalizes full-width/case variants, generates a stable collision-resistant slug, and reuses the same global tag across users instead of giving each user a private tag. Tag reuse and article association are open to any authenticated author; tag labels are not overwritten by later duplicate creates. The legacy `createTaxonomy(kind: "category", ...)` category path remains creator-scoped.  article-to-taxonomy links are replaceable transactionally during article creation/update, public taxonomy queries filter to published articles in the requested locale, and default-language labels are used as a display fallback. Taxonomy edits and deletion are limited to the creating user pending role-aware administrative policy. Authenticated `likedArticles` returns only the viewer's liked, published articles that have the requested translation. `relatedArticles` ranks other published articles in the requested locale by shared category/tag links, then same author and recency. `setArticleLike` is a retry-safe, idempotent like/unlike operation; `toggleArticleLike` remains available for compatibility. A newly created like writes a durable `article.liked` notification for the author in the same transaction, except when the author likes their own article. New comments notify the article author, and replies notify the parent comment author; the comment and its notifications commit atomically. Article likes are unique per user and article; their toggle operation locks the published article row to serialize concurrent toggles. Comment threads are stored as a parent-child relation with cascading reply deletion; public reads expose only published articles in the requested locale, and comments can only be deleted by their author.

## Integration tests

Use a disposable PostgreSQL database only:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test pnpm --filter @bot-thk/api test:integration
```

PostgreSQL tests skip when `TEST_DATABASE_URL` is unset; SQLite contract tests still run. Never set it to a production URL. Use a database dedicated to this test run: tests run migrations and create/remove uniquely identified records, and the outbox claim operation intentionally scans the whole queue. Test files are run serially because they share that queue; the contract suite still exercises concurrent claims within a test.

## Security policy helpers

- `requireAuthenticatedActor(context)` accepts identity only from the server-verified `context.user.id`.
- `resolveMessageSender(context)` returns that authenticated actor; client input such as `senderId` is deliberately ignored.
- `assertResourceOwner(actorId, ownerId)` fails closed when ownership cannot be established.
- `assertConversationParticipant(actorId, participantIds)` fails closed for missing or non-member participant lists.
- `AuthorizationError` distinguishes `UNAUTHENTICATED` from `FORBIDDEN`.

These helpers do not replace resource-level database checks in each resolver. See `docs/architecture/postgres-migration-plan.md` for persistence and optional data-import boundaries, `docs/architecture/decisions/0005-clean-architecture-and-replication.md` for multi-provider and failover tradeoffs, and `docs/architecture/persistence-adapter-contract.md` for the shared adapter acceptance contract.


## JWT access-token verification policy

The API verifies bearer access tokens; the repository does not yet implement the sign-in/token-issuance or refresh-token flow. Do not treat strict verification as proof that the full login lifecycle is production-ready.

- The verifier accepts only HMAC-SHA-256 (`HS256`) compact JWS tokens and pins the header type to the application-specific `application/vnd.bot-thk.access+jwt`; it rejects `none`, unknown algorithms, non-canonical base64url segments, detached-payload/critical header extensions, and malformed claims. This private type intentionally does not claim RFC 9068 OAuth JWT access-token-profile conformance: token issuance/refresh is not implemented here, and the current verifier uses a shared HS256 secret rather than a complete authorization-server/JWKS profile.
- Required claims: `iss`, `aud`, integer NumericDate `iat` and `exp`, non-empty stable subject `sub`, and unique session identifier `jti`. Optional `nbf` is validated when present. Issuer and audience must match server configuration.
- Access-token lifetime is bounded to **15 minutes by default** (`AUTH_JWT_MAX_TTL_SECONDS=900`). It can be configured from 60 to 86400 seconds; use a short-lived access token and build refresh-token rotation separately rather than issuing long-lived bearer tokens.
- `AUTH_JWT_SECRET` must be at least 32 bytes and should be generated from a cryptographically secure random source. Do not commit it, log tokens or secrets, reuse the same secret across unrelated token types, or accept client-supplied identity headers/body fields.
- Protected REST and GraphQL operations check the token's `jti` against durable session-revocation state. If the revocation query is missing or fails, authentication fails closed. `DELETE /api/v1/me/session` revokes the current token until its expiration.
- The trusted issuer must emit this exact application-specific access-token profile. Do not substitute `typ: at+jwt` without deliberately adopting and implementing the complete RFC 9068 profile. When wiring real sign-in, define issuer ownership, key/secret rotation (prefer asymmetric signing/JWKS if issuer and resource server are separate trust domains), refresh/reuse detection, session expiration, password reset/recovery invalidation, abuse throttling, and cookie/CSRF policy where relevant.

## REST transport

The API exposes a versioned REST business contract under `/api/v1`. REST handlers call the shared application-service facade and never call GraphQL over HTTP or access PostgreSQL directly. All REST JSON responses use `Cache-Control: no-store`. Private endpoints derive the acting user exclusively from a verified bearer JWT, reject revoked sessions and never accept client-supplied actor/owner IDs.

### Public read routes

- `GET /api/v1/health` — liveness response, independent of persistence.
- `GET /api/v1/me` — authenticated current-user identity (`{ id }`).
- `GET /api/v1/me/profile?locale=zh-CN` — current user profile; requires authentication.
- `GET /api/v1/users?query=&locale=zh-CN&limit=20` — user search; accepts an optional valid JWT for viewer-specific follow state.
- `GET /api/v1/users/:userId/followers?locale=zh-CN&limit=50` and `GET /api/v1/users/:userId/following?locale=zh-CN&limit=50` — relationship lists with complete AuthorProfile records.
- `GET /api/v1/me/liked-articles?locale=zh-CN&limit=50` — authenticated liked-article list.
- `GET /api/v1/articles?locale=zh-CN&query=&limit=20&offset=0` — published article search and pagination.
- `GET /api/v1/articles/:slug?locale=zh-CN` — one published article, or `404 NOT_FOUND`.
- `GET /api/v1/articles/:slug/related?locale=zh-CN&limit=6` — related published articles.
- `GET /api/v1/articles/:slug/like?locale=zh-CN` — like count and optional viewer liked state.
- `GET /api/v1/authors/:userId?locale=zh-CN` — public author profile addressed by stable `userId`.
- `GET /api/v1/authors/:userId/articles?locale=zh-CN&query=&limit=20&offset=0` — published articles by that author, filtered before pagination.
- `GET /api/v1/categories?locale=zh-CN&query=&limit=100&offset=0` and `GET /api/v1/categories/:slug?locale=zh-CN` — category discovery and detail.
- `GET /api/v1/categories/:slug/articles?locale=zh-CN&limit=20&offset=0` — published articles in a category.
- `GET /api/v1/tags?locale=zh-CN&query=&limit=100&offset=0` and `GET /api/v1/tags/:slug?locale=zh-CN` — hashtag discovery and detail.
- `GET /api/v1/tags/:slug/articles?locale=zh-CN&limit=20&offset=0` — published articles associated with a hashtag.
- `GET /api/v1/conversations?limit=50` — authenticated participant-scoped conversation list with last activity, unread count and last-message summary.
- `GET /api/v1/conversations/:conversationId/messages?limit=100&before=:messageId` — authenticated message history; preserves the latest-window/oldest-first ordering and same-conversation cursor validation.
- `GET /api/v1/me/notifications?limit=50` and `GET /api/v1/me/notifications/unread-count` — authenticated notification inbox and unread count.
- `GET /api/v1/articles/:slug/comments?locale=zh-CN&limit=50` — public comment tree for a published article.

### Authenticated article, profile and community routes

All routes below require a valid, non-revoked bearer JWT, except for public comment listing. JSON write bodies require `Content-Type: application/json` and are limited to 2 MiB. Unsupported body fields are rejected.

- `GET /api/v1/me/articles?locale=zh-CN&limit=50` — the signed-in user's own articles, including drafts.
- `POST /api/v1/articles` — create an article. Accepts `slug`, `title`, optional `summary`, `locale` (`zh-CN` only), `contentBlocks` (JSON array), optional `publish`, `workType`, `categoryIds` and `tagIds`. The author is derived from JWT identity.
- `PUT /api/v1/articles/:articleId` — update an article; the actor is derived from JWT and ownership is enforced in the application/persistence layer. Uses the same fields as create, and requires boolean `publish`.
- `PUT /api/v1/me/profile` — update the current user's profile using `displayName`, optional `bio`, `avatarUrl`, `websiteUrl` and optional `locale`. The profile owner is derived from JWT identity.
- `POST /api/v1/users/:userId/follow` and `DELETE /api/v1/users/:userId/follow` — idempotently follow or unfollow the target stable user ID. The returned profile includes every GraphQL AuthorProfile field, including counts, timestamps, avatar/website, locale and viewer-specific follow state.
- `DELETE /api/v1/me/session` — revoke the current verified token by its `jti`.
- `POST /api/v1/tags` — create or reuse a normalized hashtag; the actor is derived from JWT.
- `POST /api/v1/taxonomies` and `DELETE /api/v1/taxonomies/:taxonomyId` — create/delete a localized category or taxonomy; deletion is creator-scoped.
- `POST /api/v1/conversations` — create a conversation with the authenticated actor plus submitted participants.
- `POST /api/v1/conversations/:conversationId/messages` — send a message with a required `Idempotency-Key` header and JSON body `{"body":"..."}`. The sender is JWT-derived; persistence commits the message and transactional outbox intent together.
- `PATCH /api/v1/conversations/:conversationId/participants` — manage participants under the existing creator/member rules and return the complete Conversation.
- `PUT /api/v1/conversations/:conversationId/read` and `DELETE /api/v1/conversations/:conversationId` — update the current participant's read state or delete a conversation under creator/member rules.
- `PUT /api/v1/me/notifications/:notificationId/read` and `POST /api/v1/me/notifications/read-all` — recipient-scoped single/batch read-state updates; batch response is the changed-row count.
- `PUT /api/v1/articles/:slug/like?locale=zh-CN` — set an explicit like state with JSON body `{"liked": true}` or `{"liked": false}`. This is retry-safe state setting rather than a toggle.
- `POST /api/v1/articles/:slug/comments?locale=zh-CN` — create a comment or reply with `{"content": "...", "parentCommentId": null}`; replies must reference a comment on the same article.
- `DELETE /api/v1/comments/:commentId` — delete the current user's own comment. Returns `{"data":{"deleted":true}}` when deleted; the domain layer enforces ownership.

### Validation and error behavior

Repeated query parameter names are rejected with `400 BAD_USER_INPUT` because all current REST query parameters are scalar; rejected requests close the connection when a write body may remain unread. The versioned REST API currently accepts only locale `zh-CN`; unsupported locales return `400 BAD_USER_INPUT` instead of silently falling back. Article responses preserve all GraphQL Article fields, adding `author`, `categories`, and `tags` from the shared services. REST `contentBlocks` is a JSON array, while the legacy GraphQL field is a JSON-serialized string. Search terms are limited to 200 characters. Pagination limits are integers from 1 to 100 with bounded non-negative offsets. Domain validation, ownership rules, transactions and notification-outbox behavior remain in the existing application and persistence layers. Errors are mapped to stable HTTP codes and sanitized messages.

This remains a staged migration. Backend REST routes now cover the GraphQL operations inventoried in `docs/audit/rest-graphql-parity.md`, except that legacy `toggleArticleLike` is intentionally migrated to explicit `PUT liked` state-setting semantics to avoid retries inverting state. Taxonomy, conversation/message and notification routes reuse existing persistence authorization, cursor, idempotency and outbox behavior. A CI test checks the GraphQL-schema-to-REST operation inventory and shared object fields. Remaining gates are Web caller migration and end-to-end verification; remove GraphQL/Yoga only after those gates pass. Do not remove GraphQL yet.
