# API Security and Persistence Foundation

This package is the API layer of the independent BOT THK rebuild. The previous project is a source of feature/behavior evidence, not a requirement to preserve its implementation. This API currently has one implemented persistence adapter (PostgreSQL); the Clean Architecture ports are being prepared for future MongoDB and SQLite adapters.

## Runtime probes

- `GET /health` is a liveness probe and does not require persistence.
- `GET /ready` is a readiness probe: it returns `200` only when a configured persistence store passes its health check, otherwise `503` with a sanitized response. Both responses are non-cacheable.

## Versioned REST API

The standalone REST transport currently exposes public read-only endpoints alongside GraphQL. All responses use JSON and `Cache-Control: no-store`.

- `GET /api/v1/health` — liveness probe.
- `GET /api/v1/articles?locale=zh-CN&query=&limit=20&offset=0` — published article search and pagination.
- `GET /api/v1/articles/:slug?locale=zh-CN` — one published article.
- `GET /api/v1/authors/:userId?locale=zh-CN` — public author profile addressed by stable `userId`.
- `GET /api/v1/authors/:userId/articles?query=&limit=20&offset=0` — published articles for that author; the author filter runs in persistence before pagination.
- `GET /api/v1/categories?locale=zh-CN&query=&limit=20&offset=0` — localized category discovery and pagination.
- `GET /api/v1/categories/:slug?locale=zh-CN` — localized category detail.
- `GET /api/v1/categories/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles in a category.
- `GET /api/v1/tags?locale=zh-CN&query=&limit=20&offset=0` — localized public hashtag discovery and pagination.
- `GET /api/v1/tags/:slug?locale=zh-CN` — one localized hashtag, or `404 NOT_FOUND`.
- `GET /api/v1/tags/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles associated with a hashtag.

The versioned REST API accepts only `zh-CN`. Requests specifying `zh-TW`, `en`, or another locale return `400 BAD_USER_INPUT`; search terms are limited to 200 characters and limits are 1–100. Invalid query values return `400 BAD_USER_INPUT`, unknown article/category resources return `404 NOT_FOUND`, and missing persistence returns `503 SERVICE_UNAVAILABLE`. Domain errors thrown by application services map to stable REST statuses: `BAD_USER_INPUT` → 400, `FORBIDDEN` → 403, `NOT_FOUND` → 404, and `CONFLICT` / `IDEMPOTENCY_CONFLICT` → 409. The adapter does not forward domain exception text; unknown domain codes and unexpected exceptions return a generic `500 INTERNAL_SERVER_ERROR` response without internal details. Category article requests resolve the category before listing content, so unknown categories do not produce a misleading successful empty list.

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
- `DATABASE_PROVIDER` selects a registered adapter at startup. Currently only `postgres` is registered. `mongodb` and `sqlite` fail explicitly until their adapters exist and pass the shared behavior contract; the application never silently falls back to PostgreSQL.
- Message writes require an existing conversation membership. Sender identity must come from the server-verified actor, never a client-supplied `senderId`.
- Reusing an idempotency key with a different payload fails with `IDEMPOTENCY_CONFLICT`.
- JWTs must include a unique, non-empty `jti`; the API checks that session ID against PostgreSQL on each authenticated request when persistence is configured, so revoked sessions fail closed. The `revokeCurrentSession` mutation records the current `jti` until the signed token's expiry.

GraphQL is retained temporarily during the approved staged migration only. The target architecture is REST-only; do not add new GraphQL operations, and remove the GraphQL transport and Yoga dependency after the remaining operations have REST equivalents and regression coverage. The transitional GraphQL API currently exposes public `articles`, `likedArticles`, `relatedArticles`, `article`, `articleLikeInfo`, `articleComments`, `taxonomies`, `taxonomyArticles`, `authorProfile`, `searchUsers`, `followers`, and `following` queries, authenticated `myArticles`, `createArticle`, `updateArticle`, `toggleArticleLike`, `setArticleLike`, `createArticleComment`, `deleteArticleComment`, `createTaxonomy`, `deleteTaxonomy`, `updateMyProfile`, `followUser`, and `unfollowUser` operations, plus authenticated `createConversation`, `conversations`, `conversationMessages`, `updateConversationParticipants`, `markConversationAsRead`, `deleteConversation`, `sendMessage`, `notifications`, `unreadNotificationCount`, `markNotificationRead`, `markAllNotificationsRead`, and `revokeCurrentSession` operations when a store is configured. Conversation lists are scoped to the authenticated actor and include participant IDs plus the latest message summary; message history is returned oldest-first within the requested latest-message window. Message reads check database membership; sends derive `senderId` from the verified JWT subject and commit the message with its outbox intent. The notification inbox is scoped to the verified JWT subject, and read-state updates include the recipient in the SQL predicate so another user cannot inspect or mark a notification. Unread counts and batch read operations are also scoped to the authenticated actor. Notification payloads are exposed as JSON-serialized strings. The reusable outbox dispatcher leases events with `FOR UPDATE SKIP LOCKED`, marks successful delivery, and schedules failed delivery for retry. A standalone `pnpm --filter @bot-thk/api worker:notifications` process converts `message.created` outbox events into durable inbox rows. Configure it under a process supervisor alongside the API (not inside the web request process). Optional settings are `OUTBOX_POLL_INTERVAL_MS` (default `1000`), `OUTBOX_BATCH_LIMIT` (default `25`), `OUTBOX_LEASE_SECONDS` (default `60`), and `OUTBOX_RETRY_DELAY_SECONDS` (default `30`). It requires `DATABASE_URL` and uses the same PostgreSQL store; no external push provider is configured, so this worker persists in-app notifications rather than sending web push/email. Do not advertise external push delivery or the entire messaging/notification feature set as production-ready until those pieces are complete.

### Article persistence contract

Author profiles are stored with shared account-level avatar/website fields and per-locale display name/bio translations. User discovery supports localized display-name/ID search, following/follower lists, follower/following counts, and viewer-specific follow state. Follow and unfollow mutations derive the follower from JWT identity; a newly created follow writes an idempotent relationship and a durable `user.followed` notification in the same transaction; `updateMyProfile` derives the profile owner from the verified JWT. Published article results expose a nullable localized `author` profile when the owner has configured that locale. Articles are stored independently of the legacy MongoDB backend. Each article has one unique slug, author identity derived from verified JWT `sub`, draft/published state, and translated content rows keyed by `zh-TW` or `en`. Public list/detail queries return published content only; `myArticles` includes the authenticated owner's drafts. Article bodies are stored as validated JSON content blocks (`paragraph`, `heading`, `quote`, `list`, `image`, `code`). `contentBlocks` is a JSON-serialized string at the GraphQL boundary. Create/update operations enforce author ownership, reject duplicate slugs, and validate body shape before persistence. Category/tag records and their localized labels are persisted separately from articles. `createTag(name, locale)` supports user-created Unicode hashtags (including Traditional Chinese), strips a leading `#`, normalizes full-width/case variants, generates a stable collision-resistant slug, and reuses the same global tag across users instead of giving each user a private tag. Tag reuse and article association are open to any authenticated author; tag labels are not overwritten by later duplicate creates. The legacy `createTaxonomy(kind: "category", ...)` category path remains creator-scoped.  article-to-taxonomy links are replaceable transactionally during article creation/update, public taxonomy queries filter to published articles in the requested locale, and default-language labels are used as a display fallback. Taxonomy edits and deletion are limited to the creating user pending role-aware administrative policy. Authenticated `likedArticles` returns only the viewer's liked, published articles that have the requested translation. `relatedArticles` ranks other published articles in the requested locale by shared category/tag links, then same author and recency. `setArticleLike` is a retry-safe, idempotent like/unlike operation; `toggleArticleLike` remains available for compatibility. A newly created like writes a durable `article.liked` notification for the author in the same transaction, except when the author likes their own article. New comments notify the article author, and replies notify the parent comment author; the comment and its notifications commit atomically. Article likes are unique per user and article; their toggle operation locks the published article row to serialize concurrent toggles. Comment threads are stored as a parent-child relation with cascading reply deletion; public reads expose only published articles in the requested locale, and comments can only be deleted by their author.

## Integration tests

Use a disposable PostgreSQL database only:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test pnpm --filter @bot-thk/api test:integration
```

Tests skip when `TEST_DATABASE_URL` is unset. Never set it to a production URL. The test suite runs migrations and creates/removes uniquely identified records.

## Security policy helpers

- `requireAuthenticatedActor(context)` accepts identity only from the server-verified `context.user.id`.
- `resolveMessageSender(context)` returns that authenticated actor; client input such as `senderId` is deliberately ignored.
- `assertResourceOwner(actorId, ownerId)` fails closed when ownership cannot be established.
- `assertConversationParticipant(actorId, participantIds)` fails closed for missing or non-member participant lists.
- `AuthorizationError` distinguishes `UNAUTHENTICATED` from `FORBIDDEN`.

These helpers do not replace resource-level database checks in each resolver. See `docs/architecture/postgres-migration-plan.md` for persistence and optional data-import boundaries, `docs/architecture/decisions/0005-clean-architecture-and-replication.md` for multi-provider and failover tradeoffs, and `docs/architecture/persistence-adapter-contract.md` for the shared adapter acceptance contract.


## REST transport

The API exposes versioned, public, read-only REST endpoints alongside GraphQL. Both transports call the shared application-service facade; REST handlers do not call GraphQL over HTTP or access PostgreSQL directly. REST JSON responses use `Cache-Control: no-store`.

- `GET /api/v1/health` — liveness response, independent of persistence.
- `GET /api/v1/articles?locale=zh-CN&query=&limit=20&offset=0` — published article search and pagination.
- `GET /api/v1/articles/:slug?locale=zh-CN` — one published article, or `404 NOT_FOUND`.
- `GET /api/v1/categories?locale=zh-CN&query=&limit=20&offset=0` — localized category discovery and pagination.
- `GET /api/v1/categories/:slug?locale=zh-CN` — one localized category, or `404 NOT_FOUND`.
- `GET /api/v1/categories/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles in a category.
- `GET /api/v1/tags?locale=zh-CN&query=&limit=20&offset=0` — localized hashtag discovery and pagination.
- `GET /api/v1/tags/:slug?locale=zh-CN` — one localized hashtag, or `404 NOT_FOUND`.
- `GET /api/v1/tags/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles associated with a hashtag.

Locale must be `zh-CN`, `zh-TW`, or `en`; search terms are limited to 200 characters; `limit` must be an integer from 1 to 100 and `offset` must be a non-negative integer within the endpoint's bound. Invalid inputs return `400 BAD_USER_INPUT`; missing taxonomy resources (including tags without a localized label for the requested locale) return a stable `404 NOT_FOUND`. Tag article requests resolve the localized tag before querying articles so a nonexistent tag never masquerades as an empty successful list. The shared persistence queries return published articles in the requested locale only.

This remains a partial REST surface, not full transport parity: authenticated writes, profile and engagement routes, and complete cross-transport contract coverage are still pending. Add resources through the shared application services and extend transport-level tests before claiming behavioral parity.
