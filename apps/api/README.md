# API Security and Persistence Foundation

This package is the API layer of the independent BOT THK rebuild. The previous project is a source of feature/behavior evidence, not a requirement to preserve its implementation. PostgreSQL is the only registered runtime provider. A composed SQLite adapter and some shared contract tests exist, but SQLite is not enabled as a runtime provider until its full acceptance gates pass; MongoDB remains planned.

## Runtime probes

- `GET /health` is a liveness probe and does not require persistence.
- `GET /ready` is a readiness probe: it returns `200` only when a configured persistence store passes its health check, otherwise `503` with a sanitized response. Both responses are non-cacheable.

## Versioned REST API

The standalone REST transport exposes public read endpoints and initial authenticated article-management endpoints alongside the transitional GraphQL runtime. All REST responses use JSON and `Cache-Control: no-store`.

- `POST /api/v1/auth/register` and `POST /api/v1/auth/login` — create an unverified email/password account or sign in; return access and refresh tokens in JSON.
- `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout` — rotate or revoke a refresh-token session. Reuse revokes the whole session family.
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
Article write requests require `Authorization: Bearer <JWT>` with a valid issuer, audience, expiry and `jti`; revoked sessions fail with `401 UNAUTHENTICATED`. The server derives `authorId`/`actorId` from the verified JWT and rejects client-supplied identity fields. Write bodies must use `Content-Type: application/json`, contain a JSON object, and fit within 2 MiB. `contentBlocks` is a JSON array at the REST boundary; `contentBlocksVersion` defaults to `0` for legacy plain-text blocks and may be set to `1` for rich text; only `zh-CN` is accepted. Create returns `201`, update returns `200`, and domain failures map to the documented sanitized status codes. Invalid query values return `400 BAD_USER_INPUT`, unknown article/category resources return `404 NOT_FOUND`, and missing persistence returns `503 SERVICE_UNAVAILABLE`. Domain errors thrown by application services map to stable REST statuses: `BAD_USER_INPUT` → 400, `FORBIDDEN` → 403, `NOT_FOUND` → 404, and `CONFLICT` / `IDEMPOTENCY_CONFLICT` → 409. The adapter does not forward domain exception text; unknown domain codes and unexpected exceptions return a generic `500 INTERNAL_SERVER_ERROR` response without internal details. Category article requests resolve the category before listing content, so unknown categories do not produce a misleading successful empty list.

## PostgreSQL setup

Set `DATABASE_PROVIDER=postgres` and `DATABASE_URL` to a developer-owned PostgreSQL database, then run:

```sh
pnpm --filter @bot-thk/api migrate
pnpm --filter @bot-thk/api start
```

Migrations are explicit release steps; API startup does not silently change the schema. Never run the migration command against production without a reviewed release plan and backup. **Stop old API instances and workers before enabling this version**: older logout does not revoke new refresh families, and older workers do not serialize delivery with conversation changes. See the [authentication contract](../../docs/architecture/api-authentication.md) for configuration, limitations and rollout details.

## Persistence API

- `createPostgresClient()` creates a postgres.js connection pool and validates the connection URL.
- `runMigrations(sql)` applies ordered SQL migrations under an advisory lock and records versions.
- `createPostgresStore(sql)` is the current infrastructure adapter.
- `src/application/persistence-ports.ts` defines the required domain-grouped adapter contract, and `src/application/services.ts` is the application-facing composition seam. Domain validation and errors live under `src/domain/`; PostgreSQL-specific queries, transactions, constraints and row mapping remain in `src/persistence/`.
- `DATABASE_PROVIDER` selects a registered adapter at startup. Currently only `postgres` is registered. `mongodb` and `sqlite` fail explicitly until their adapters pass the full provider acceptance gates; the application never silently falls back to PostgreSQL.
- Message writes require an existing conversation membership. Sender identity must come from the server-verified actor, never a client-supplied `senderId`.
- Reusing an idempotency key with a different payload fails with `IDEMPOTENCY_CONFLICT`.
- JWTs require a non-empty `jti`; the API checks its durable revocation on each authenticated request and fails closed. For self-hosted sessions, REST/GraphQL logout revokes the whole refresh family and all issued access-token IDs. An independently issued token can only have its own `jti` revoked locally.

GraphQL is retained temporarily during the approved staged migration only. The target architecture is REST-only; do not add new GraphQL operations, and remove the GraphQL transport and Yoga dependency after the remaining operations have REST equivalents and regression coverage. The transitional GraphQL API currently exposes public `articles`, `likedArticles`, `relatedArticles`, `article`, `articleLikeInfo`, `articleComments`, `taxonomies`, `taxonomyArticles`, `authorProfile`, `searchUsers`, `followers`, and `following` queries, authenticated `myArticles`, `createArticle`, `updateArticle`, `toggleArticleLike`, `setArticleLike`, `createArticleComment`, `deleteArticleComment`, `createTaxonomy`, `deleteTaxonomy`, `updateMyProfile`, `followUser`, and `unfollowUser` operations, plus authenticated `createConversation`, `conversations`, `conversationMessages`, `updateConversationParticipants`, `markConversationAsRead`, `deleteConversation`, `sendMessage`, `notifications`, `unreadNotificationCount`, `markNotificationRead`, `markAllNotificationsRead`, and `revokeCurrentSession` operations when a store is configured. Conversation lists are scoped to the authenticated actor and include participant IDs plus the latest message summary; message history is returned oldest-first within the requested latest-message window. Message reads check database membership; sends derive `senderId` from the verified JWT subject and commit the message with its outbox intent. The notification inbox is scoped to the verified JWT subject, and read-state updates include the recipient in the SQL predicate so another user cannot inspect or mark a notification. Unread counts and batch read operations are also scoped to the authenticated actor. Notification payloads are exposed as JSON-serialized strings. The reusable outbox dispatcher leases events with `FOR UPDATE SKIP LOCKED`, marks successful delivery, and schedules failed delivery for retry. A standalone `pnpm --filter @bot-thk/api worker:notifications` process converts `message.created` outbox events into durable inbox rows. Configure it under a process supervisor alongside the API (not inside the web request process). Optional settings are `OUTBOX_POLL_INTERVAL_MS` (default `1000`), `OUTBOX_BATCH_LIMIT` (default `25`), `OUTBOX_LEASE_SECONDS` (default `60`), and `OUTBOX_RETRY_DELAY_SECONDS` (default `30`). It requires `DATABASE_URL` and uses the same PostgreSQL store; no external push provider is configured, so this worker persists in-app notifications rather than sending web push/email. Do not advertise external push delivery or the entire messaging/notification feature set as production-ready until those pieces are complete.

### Outbox leases and worker rollout

- Each claim gets a new internal `lease_token`. Acknowledgement and retry require that token and a still-active lease; an expired, released or superseded claim cannot complete or postpone an event. A successful retry schedule releases the token. PostgreSQL checks expiry after acquiring the row lock; SQLite uses its write lock and database clock.
- `OUTBOX_BATCH_LIMIT` is the maximum number processed in one dispatch, but events are claimed **one at a time**, just before delivery. This avoids letting later events' leases expire while they wait behind a slow earlier event; it increases database round trips. Claims are not renewed automatically, so configure `OUTBOX_LEASE_SECONDS` longer than the expected maximum time for a single delivery and monitor slow/repeated attempts.
- Delivery is **at least once**, not exactly once. A worker can persist notifications and then crash or lose its lease before acknowledgement. The next worker may invoke delivery again; inbox writes deduplicate by recipient and event key. Any future external push consumer must provide its own idempotency and cannot assume a lease prevents side effects after expiry. Do not expose or log lease tokens.
- Worker output is newline-delimited structured JSON. Failed-event records include only the event ID/type, attempt count, error class, and whether rescheduling succeeded; request payloads, tokens and raw exception messages are intentionally omitted. `retryScheduled: false` with no `retryScheduleErrorName` means the claim was no longer eligible for retry (for example, its lease was lost); a non-null `retryScheduleErrorName` means retry scheduling itself failed. Aggregate batch logs report claimed/delivered/failed counts. Queue-depth metrics, alert thresholds and external log shipping remain separate operations work.
- **Upgrade/rollback coordination:** stop and drain all old notification workers first. After an approved backup/release plan, apply the additive PostgreSQL migration `0010_outbox_lease_tokens` using the explicit migration command, then start only workers with the new code. Existing pending/delivered rows are preserved; previously leased rows become claimable when their existing `available_at` expires. Do not run old and new workers together: old workers can still acknowledge without a token. For rollback, stop all workers and assess the loss of fencing before restarting an older version; removing the column is not required for old code. No production migration is implied by this change.
- Message writes, recipient selection and inbox inserts serialize with membership edits and deletion using the conversation lock. This prevents a removed sender from writing after removal commits and prevents deletion from missing a late outbox event. The notification consumer resolves active members at **delivery time**, excluding the original sender even if they have left; a later joiner can receive an older pending message notification. A stale event after deletion creates nothing. Existing partial inbox deliveries are preserved and deduplicated; a payload conflict rolls back the new transaction. Old workers and API instances must be stopped before upgrade because they bypass this serialization. See [ADR 0009](../../docs/architecture/decisions/0009-message-notification-recipient-timing.md).

### Article persistence contract

Author profiles are stored with shared account-level avatar/website fields and per-locale display name/bio translations. User discovery supports localized display-name/ID search, following/follower lists, follower/following counts, and viewer-specific follow state. Follow and unfollow mutations derive the follower from JWT identity; a newly created follow writes an idempotent relationship and a durable `user.followed` notification in the same transaction; `updateMyProfile` derives the profile owner from the verified JWT. Published article results expose a nullable localized `author` profile when the owner has configured that locale. Articles are stored independently of the legacy MongoDB backend. Each article has one unique slug, author identity derived from verified JWT `sub`, draft/published state, and translated content rows keyed by `zh-TW` or `en`. Public list/detail queries return published content only; `myArticles` includes the authenticated owner's drafts. Article bodies are stored as validated JSON content blocks (`paragraph`, `heading`, `quote`, `list`, `image`, `code`) with a persisted `contentBlocksVersion`. Version 0 is the backward-compatible plain-text contract. Version 1 adds optional `inlines` arrays to text blocks and `itemInlines` arrays to list blocks; each run is `{ text, marks?, href? }`, marks are unique values from `bold`, `italic`, `underline`, `strikethrough`, and `code`, and concatenated run text must exactly equal the block/list-item plain-text fallback. Link URLs are limited to valid HTTP(S) URLs without credentials or site-root-relative paths; protocol-relative URLs, executable schemes, arbitrary HTML and unsupported node properties are rejected. A document is limited to 200 blocks, 1,000 inline runs per text/list-item entry, 50,000 characters per code block and 1,000,000 serialized characters. `contentBlocks` is a JSON-serialized string at the GraphQL boundary. Create/update operations enforce author ownership, reject duplicate slugs, and validate body shape before persistence. Category/tag records and their localized labels are persisted separately from articles. `createTag(name, locale)` supports user-created Unicode hashtags (including Traditional Chinese), strips a leading `#`, normalizes full-width/case variants, generates a stable collision-resistant slug, and reuses the same global tag across users instead of giving each user a private tag. Tag reuse and article association are open to any authenticated author; tag labels are not overwritten by later duplicate creates. The legacy `createTaxonomy(kind: "category", ...)` category path remains creator-scoped.  article-to-taxonomy links are replaceable transactionally during article creation/update, public taxonomy queries filter to published articles in the requested locale, and default-language labels are used as a display fallback. Taxonomy edits and deletion are limited to the creating user pending role-aware administrative policy. Authenticated `likedArticles` returns only the viewer's liked, published articles that have the requested translation. `relatedArticles` ranks other published articles in the requested locale by shared category/tag links, then same author and recency. `setArticleLike` is a retry-safe, idempotent like/unlike operation; `toggleArticleLike` remains available for compatibility. A newly created like writes a durable `article.liked` notification for the author in the same transaction, except when the author likes their own article. New comments notify the article author, and replies notify the parent comment author; the comment and its notifications commit atomically. Article likes are unique per user and article; their toggle operation locks the published article row to serialize concurrent toggles. Comment threads are stored as a parent-child relation with cascading reply deletion; public reads expose only published articles in the requested locale, and comments can only be deleted by their author.

## Integration tests

Use a disposable PostgreSQL database only:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test pnpm --filter @bot-thk/api test:integration
```

PostgreSQL tests skip when `TEST_DATABASE_URL` is unset; SQLite contract tests still run. Never set it to a production URL. Use a database dedicated to this test run: tests apply migrations, create/remove test records, claim from the whole outbox, and exercise bounded cleanup of expired authentication state. Test files run serially because they share the database; individual contracts still exercise concurrency.

## Security policy helpers

- `requireAuthenticatedActor(context)` accepts identity only from the server-verified `context.user.id`.
- `resolveMessageSender(context)` returns that authenticated actor; client input such as `senderId` is deliberately ignored.
- `assertResourceOwner(actorId, ownerId)` fails closed when ownership cannot be established.
- `assertConversationParticipant(actorId, participantIds)` fails closed for missing or non-member participant lists.
- `AuthorizationError` distinguishes `UNAUTHENTICATED` from `FORBIDDEN`.

These helpers do not replace resource-level database checks in each resolver. See `docs/architecture/postgres-migration-plan.md` for persistence and optional data-import boundaries, `docs/architecture/decisions/0005-clean-architecture-and-replication.md` for multi-provider and failover tradeoffs, and `docs/architecture/persistence-adapter-contract.md` for the shared adapter acceptance contract.


## Authentication and access-token policy

The standalone API issues self-hosted access/refresh credentials as well as verifying compatible independently issued JWTs. It uses salted scrypt passwords, one-time refresh rotation and durable session-family revocation; authentication bodies are limited to 4 KiB. The initial registration flow does **not** verify email, implement account recovery or define browser-safe token storage, so it is not a production-ready account system. See the complete [authentication contract](../../docs/architecture/api-authentication.md) for API requests, TTLs, throttling, unverified-email and enumeration risks, missing controls, and deployment/rollback constraints.

The verifier pins `HS256`, private type `application/vnd.bot-thk.access+jwt`, issuer/audience, `iat`/`exp`, `sub` and `jti`; its default maximum access lifetime is 15 minutes. It is not an OAuth/OIDC or RFC 9068 implementation. The API never trusts client identity headers or actor IDs and fails closed when revocation cannot be checked. Never commit or log passwords, bearer/refresh credentials, cookies or signing secrets.

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
- `POST /api/v1/articles` — create an article. Accepts `slug`, `title`, optional `summary`, `locale` (`zh-CN` only), `contentBlocks` (JSON array), optional `contentBlocksVersion` (`0` by default, `1` for inline rich text), `publish`, `workType`, `categoryIds` and `tagIds`. The author is derived from JWT identity.
- `PUT /api/v1/articles/:articleId` — update an article; the actor is derived from JWT and ownership is enforced in the application/persistence layer. Uses the same fields as create, and requires boolean `publish`.
- `PUT /api/v1/me/profile` — update the current user's profile using `displayName`, optional `bio`, `avatarUrl`, `websiteUrl` and optional `locale`. The profile owner is derived from JWT identity.
- `POST /api/v1/users/:userId/follow` and `DELETE /api/v1/users/:userId/follow` — idempotently follow or unfollow the target stable user ID. The returned profile includes every GraphQL AuthorProfile field, including counts, timestamps, avatar/website, locale and viewer-specific follow state.
- `DELETE /api/v1/me/session` — revoke the self-hosted session family associated with the verified access token; for external JWTs revoke only the presented `jti`.
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

This remains a staged migration. The article rich-text contract is application-owned and versioned; Lexical JSON and client-supplied HTML are not accepted as canonical content. The current version-1 scope includes inline marks and hyperlinks inside existing block types. A pure serialized-Lexical adapter supports paragraphs, h2–h4 headings, quotes without attribution, ordered/unordered lists, inline text/link/marks, and code. It rejects custom image nodes, quote attribution, nested lists, unsupported CSS/alignment/direction metadata, and other payload features that the application contract cannot preserve; comment rich text and approved media upload integration remain open tasks. Backend REST routes now cover the GraphQL operations inventoried in `docs/audit/rest-graphql-parity.md`, except that legacy `toggleArticleLike` is intentionally migrated to explicit `PUT liked` state-setting semantics to avoid retries inverting state. Taxonomy, conversation/message and notification routes reuse existing persistence authorization, cursor, idempotency and outbox behavior. A CI test checks the GraphQL-schema-to-REST operation inventory and shared object fields. Remaining gates are Web caller migration and end-to-end verification; remove GraphQL/Yoga only after those gates pass. Do not remove GraphQL yet.
