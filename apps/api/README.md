# API Security and Persistence Foundation

This package is the backend API of the independent BOT THK rebuild. Versioned REST under `/api/v1` is the sole business HTTP API. The Web public-content caller has migrated to REST, and the GraphQL schema, runtime, `/graphql` endpoint, direct dependencies, and transport-specific tests have been removed. SQLite is the default provider for new/local installs, PostgreSQL remains supported when selected, and MongoDB is planned but not yet implemented. All providers must pass the shared persistence behavior contracts; unsupported providers fail closed.

## Runtime probes

- `GET /health` is a liveness probe and does not require persistence.
- `GET /ready` is a readiness probe: it returns `200` only when a configured persistence store passes its health check, otherwise `503` with a sanitized response. Both responses are non-cacheable.

## Write idempotency

The reviewed mutation-by-mutation classification and follow-up acceptance plan for `Idempotency-Key` is maintained in [the REST write idempotency inventory](../../docs/audit/rest-write-idempotency-inventory.md). Keep that inventory current when adding or changing a REST mutation. The current comment-create implementation is a first slice; do not assume all write routes support replay semantics.

## Write rate limits

All business write routes under `/api/v1` use the shared persistent rate-limit port. Limits are enforced independently by verified user ID and the TCP peer IP, with a route-specific bucket; requests without a valid viewer identity are still covered by the IP bucket. Bucket identifiers are HMAC digests, not raw account IDs or IP addresses. The API ignores client-supplied `X-Forwarded-For`; deployments behind a reverse proxy must configure trusted edge/proxy rate limiting rather than forwarding untrusted client values.

| Write operation | Per verified user | Per socket IP | Window |
| --- | ---: | ---: | --- |
| Create article | 10 | 30 | 1 hour |
| Update article | 20 | 60 | 1 hour |
| Update profile | 20 | 60 | 1 hour |
| Create comment | 20 | 60 | 1 minute |
| Send message | 30 | 120 | 1 minute |
| Follow/unfollow, set article-like state | 60 | 120 | 1 minute |
| Create/delete taxonomy, delete comment | 30–60 | 60–120 | 1 minute |
| Other conversation/session/notification writes | 60 | 120 | 1 minute |

The existing registration/login/refresh/logout policies remain separately stricter. Rate-limit state is stored using the same atomic persistent counter contract on SQLite and PostgreSQL, so counters are not limited to a single API process. Exceeded limits return `429 RATE_LIMITED` and a positive `Retry-After` number of seconds. Authentication writes still fail closed if JWT configuration is missing or invalid.

## Versioned REST API

The versioned REST transport exposes business endpoints under `/api/v1`, with JSON responses and `Cache-Control: no-store`. Unknown legacy paths, including `/graphql`, return a sanitized JSON `404 NOT_FOUND` response.

- `POST /api/v1/auth/forgot-password` — ask for a recovery link with `{"email": "..."}`. Answers `202 {"data":{"ok":true}}` whether or not the address has an account: telling the two apart would be an account-enumeration oracle. The work (issue a single-use token, hand it to the mailer) only happens when there is an account behind the address.
- `POST /api/v1/auth/reset-password` — spend a recovery link with `{"token": "...", "password": "..."}`. The token is a 32-byte base64url value that arrives by mail and is redeemed in the body, never in a path; it works once and expires after 30 minutes. The password is held to registration rules (12–128 characters), and **every session of the account is revoked** — a recovered account is signed out everywhere. `401` for a token that was never issued, is already spent or has expired; `400` for a malformed token or a weak password.
- `POST /api/v1/auth/verify-email` — spend a verification link with `{"token": "..."}`. Stamps `email_verified_at` on the account. Verification **gates nothing**: an unverified address still signs in, publishes and comments; it only records that the address was reachable once.
- `POST /api/v1/me/email-verification` — authenticated, sends (or re-sends) the verification link for the signed-in account's own address. `202 {"data":{"ok":true,"alreadyVerified":false}}`; an already verified address is not mailed again.

Outbound mail goes through the `IdentityMailer` port (`apps/api/src/application/identity-mailer.ts`). Its default implementation writes a structured log line and, by default, **not the link** — a log line that can reset a password is a password reset waiting to be read; set `AUTH_IDENTITY_MAIL_LOG_LINK=1` to include it during local development, and `AUTH_IDENTITY_BASE_URL` for the public origin the links point at.

To actually deliver, point the API at an SMTP **submission** relay — `MAIL_SMTP_HOST` plus `MAIL_FROM` are enough; without them the log mailer stays in place. It is generic submission rather than a provider SDK ([ADR 0015](../docs/architecture/decisions/0015-transactional-mail-over-a-generic-smtp-relay.md)): Brevo, Resend, SMTP2GO and a mailbox host are all the same code with different environment variables. TLS is mandatory by default — a relay that does not advertise STARTTLS is refused before any credential is sent, and an unrecognized `MAIL_SMTP_SECURITY` value falls back to `starttls`, never to plaintext.

| Variable | Meaning |
| --- | --- |
| `MAIL_SMTP_HOST` | relay hostname; mail is sent only when this **and** `MAIL_FROM` are set |
| `MAIL_SMTP_PORT` | default 587 (`starttls`), 465 (`implicit`) |
| `MAIL_SMTP_SECURITY` | `starttls` (default), `implicit`, or `none` for a local relay |
| `MAIL_SMTP_USER` / `MAIL_SMTP_PASSWORD` | relay credentials; never written to a log |
| `MAIL_SMTP_TIMEOUT_MS` | per-reply wait, capped at 60 000 ms |
| `MAIL_FROM` | envelope sender and `From` header |
| `MAIL_FROM_NAME` | optional display name (encoded when it is not ASCII) |

A delivery failure is recorded as `api_identity_mail_deliveries_total{…,outcome="failed"}` and logged as `identity_mail_failed` with the purpose and the error code — never the address — and never fails the request: the token is already stored, so the user can simply ask for a new link. Because the request answers `202` either way, that counter is the only thing that can tell an operator recovery is broken; see [alerting on account mail](../docs/operations/api-observability.md#alerting-on-account-mail).

One retry is attempted, and only for a failure that happened **before** the relay could have accepted anything (a refused connection, a DNS miss, a connect timeout). Once the server has opened its mouth — a rejected credential, a rejected recipient, a lost reply to `DATA` — the failure is final: retrying a message the relay may already have queued is how one reset link becomes two mails. The retry shares a total budget with the first attempt (`MAIL_SMTP_DELIVERY_DEADLINE_MS`, default 2000 ms, capped at 10 000), so a relay that hangs for ten seconds is not asked twice.

- `POST /api/v1/auth/register` and `POST /api/v1/auth/login` — create an unverified email/password account or sign in; return access and refresh tokens in JSON.
- `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout` — rotate or revoke a refresh-token session. Reuse revokes the whole session family.
- `GET /api/v1/health` — liveness probe.
- `GET /api/v1/articles?locale=zh-CN&query=&limit=20&offset=0` — published article search and pagination.
- `GET /api/v1/articles/:slug?locale=zh-CN` — one published article.
- `GET /api/v1/me/articles?locale=zh-CN&limit=50` — the authenticated actor's own drafts and published articles.
- `POST /api/v1/articles` — create an article as the authenticated actor.
- `PUT /api/v1/articles/:articleId` — update an article using either application `contentBlocks` or write-only Lexical `editorState`; ownership is checked against the authenticated actor, and Lexical input is normalized to application version 1.
- `GET /api/v1/authors/:userId?locale=zh-CN` — public author profile addressed by stable `userId`.
- `GET /api/v1/authors/:userId/articles?query=&limit=20&offset=0` — published articles for that author; the author filter runs in persistence before pagination.
- `GET /api/v1/categories?locale=zh-CN&query=&limit=100&offset=0` — localized category discovery and pagination.
- `GET /api/v1/categories/:slug?locale=zh-CN` — localized category detail.
- `GET /api/v1/categories/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles in a category.
- `GET /api/v1/tags?locale=zh-CN&query=&limit=100&offset=0` — localized public hashtag discovery and pagination.
- `GET /api/v1/tags/:slug?locale=zh-CN` — one localized hashtag, or `404 NOT_FOUND`.
- `GET /api/v1/tags/:slug/articles?locale=zh-CN&limit=20&offset=0` — published localized articles associated with a hashtag.

The versioned REST API accepts `zh-CN`, `zh-TW`, and `en`. Requests specifying another locale return `400 BAD_USER_INPUT`; search terms are limited to 200 characters and limits are 1–100. Comment creation accepts legacy `content` plain text or exactly one of `contentBlocks` / `editorState` for rich comments. Rich comments use version 1, are limited to 20 paragraph blocks and 5,000 fallback characters, and allow only application-v1 inline marks and safe links. The existing `content` field remains the canonical plain-text fallback for older clients; versioned blocks are stored separately and exposed alongside it.
Article write requests require `Authorization: Bearer <JWT>` with a valid issuer, audience, expiry and `jti`; revoked sessions fail with `401 UNAUTHENTICATED`. The server derives `authorId`/`actorId` from the verified JWT and rejects client-supplied identity fields. Write bodies must use `Content-Type: application/json`, contain a JSON object, and fit within 2 MiB. For article create/update, send exactly one of `contentBlocks` (the application-owned JSON block array) or `editorState` (a serialized Lexical EditorState object). The write-only `editorState` ingress is validated by the strict adapter and immediately normalized to application content version `1`; Lexical JSON is never persisted or returned. Existing `contentBlocksVersion` behavior is unchanged: it defaults to `0` for legacy block arrays and may be set to `1` for rich text; an `editorState` request must use version `1` if the field is supplied. Image/custom nodes and all unsupported metadata still fail closed. Only `zh-CN` is accepted. Create returns `201`, update returns `200`, and domain failures map to the documented sanitized status codes. Invalid query values return `400 BAD_USER_INPUT`, unknown article/category resources return `404 NOT_FOUND`, and missing persistence returns `503 SERVICE_UNAVAILABLE`. Domain errors thrown by application services map to stable REST statuses: `BAD_USER_INPUT` → 400, `FORBIDDEN` → 403, `NOT_FOUND` → 404, and `CONFLICT` / `IDEMPOTENCY_CONFLICT` → 409. The adapter does not forward domain exception text; unknown domain codes and unexpected exceptions return a generic `500 INTERNAL_SERVER_ERROR` response without internal details. Category article requests resolve the category before listing content, so unknown categories do not produce a misleading successful empty list.

## SQLite-first local setup

Fresh installations use SQLite by default at `./data/no-wave.sqlite`, resolved against this package directory (so `apps/api/data/no-wave.sqlite` when started through pnpm). The location may be changed with `DATABASE_PATH`; local database files and their WAL sidecars are ignored by Git. Run migrations before starting the API:

```sh
pnpm --filter @bot-thk/api migrate   # or `pnpm db:migrate` from the repository root
pnpm --filter @bot-thk/api start     # or `pnpm dev:api` / `pnpm dev` for API + Web
```

`pnpm --filter @bot-thk/api dev` runs the API under `node --watch`. From the
repository root, `pnpm dev` starts the API and the Web dev server together with
the readiness gates described in
[Local development](../../docs/development/local-development.md), and
`pnpm check:local` verifies database -> API -> Web connectivity.

`AUTH_JWT_SECRET` must be at least 32 bytes. The REST layer reports a missing or
short secret as `503 SERVICE_UNAVAILABLE` on the authentication routes, so the
root tooling checks it before starting the process.

Migrations remain an explicit step. Startup fails closed when the SQLite schema is missing or behind. `DATABASE_AUTO_MIGRATE=true` is an opt-in for controlled local/test setup only; it should not replace a reviewed release migration step.

An existing environment that sets only `DATABASE_URL` continues to select PostgreSQL for backwards compatibility. For new PostgreSQL deployments, set `DATABASE_PROVIDER=postgres` explicitly.

## PostgreSQL setup

Set `DATABASE_PROVIDER=postgres` and `DATABASE_URL` to a developer-owned PostgreSQL database, then run:

```sh
pnpm --filter @bot-thk/api migrate
pnpm --filter @bot-thk/api start
```

Migrations are explicit release steps; API startup does not silently change the schema. Never run the migration command against production without a reviewed release plan and backup. **Stop old API instances and workers before enabling this version**: older logout does not revoke new refresh families, and older workers do not serialize delivery with conversation changes. See the [authentication contract](../../docs/architecture/api-authentication.md) for configuration, limitations and rollout details.

## Persistence API

- `createSqliteClient()` opens a local SQLite database with foreign keys, a busy timeout and WAL for file-backed databases.
- `runSqliteMigrations(db)` applies ordered SQLite-native migrations transactionally; `pnpm --filter @bot-thk/api migrate` selects the matching migration runner for the chosen provider.
- `createSqliteStore(db)` composes the SQLite domain slices into the full persistence adapter and is the default fresh-install provider.
- `createPostgresClient()`, `runMigrations(sql)` and `createPostgresStore(sql)` remain the supported PostgreSQL adapter and migration path.
- `src/application/persistence-ports.ts` defines the required domain-grouped adapter contract, and `src/application/services.ts` is the application-facing composition seam. Domain validation and errors live under `src/domain/`; PostgreSQL-specific queries, transactions, constraints and row mapping remain in `src/persistence/`.
- `DATABASE_PROVIDER` selects the adapter at startup. New installs default to SQLite; a legacy `DATABASE_URL` with no provider keeps PostgreSQL selected. PostgreSQL remains supported. MongoDB is not yet registered and fails explicitly; there is no silent fallback to another engine. Changing this setting alone is not a live data migration.
- Message writes require an existing conversation membership. Sender identity must come from the server-verified actor, never a client-supplied `senderId`.
- Reusing an idempotency key with a different payload fails with `IDEMPOTENCY_CONFLICT`.
- JWTs require a non-empty `jti`; the API checks its durable revocation on each authenticated request and fails closed. For self-hosted sessions, REST logout revokes the whole refresh family and all issued access-token IDs. An independently issued token can only have its own `jti` revoked locally.

The REST-only migration is complete: public reads and authenticated writes are exposed through the documented versioned REST routes under `/api/v1`; there is no GraphQL transport or `/graphql` endpoint. The historical operation-by-operation inventory remains in `docs/audit/rest-graphql-parity.md` as a migration record, not as a live API contract. Conversation lists are scoped to the authenticated actor and include participant IDs plus the latest message summary; message history is returned oldest-first within the requested latest-message window. Message reads check database membership; sends derive `senderId` from the verified JWT subject and commit the message with its outbox intent. The notification inbox is scoped to the verified JWT subject, and read-state updates include the recipient in the SQL predicate so another user cannot inspect or mark a notification. Unread counts and batch read operations are also scoped to the authenticated actor. Notification payloads are exposed as JSON-serialized strings. The reusable outbox dispatcher leases events with `FOR UPDATE SKIP LOCKED`, marks successful delivery, and schedules failed delivery for retry. A standalone `pnpm --filter @bot-thk/api worker:notifications` process converts `message.created` outbox events into durable inbox rows. Configure it under a process supervisor alongside the API (not inside the web request process). Optional settings are `OUTBOX_POLL_INTERVAL_MS` (default `1000`), `OUTBOX_BATCH_LIMIT` (default `25`), `OUTBOX_LEASE_SECONDS` (default `60`), and `OUTBOX_RETRY_DELAY_SECONDS` (default `30`). It requires `DATABASE_URL` and uses the same PostgreSQL store; no external push provider is configured, so this worker persists in-app notifications rather than sending web push/email. Do not advertise external push delivery or the entire messaging/notification feature set as production-ready until those pieces are complete.

### Outbox leases and worker rollout

- Each claim gets a new internal `lease_token`. Acknowledgement and retry require that token and a still-active lease; an expired, released or superseded claim cannot complete or postpone an event. A successful retry schedule releases the token. PostgreSQL checks expiry after acquiring the row lock; SQLite uses its write lock and database clock.
- `OUTBOX_BATCH_LIMIT` is the maximum number processed in one dispatch, but events are claimed **one at a time**, just before delivery. This avoids letting later events' leases expire while they wait behind a slow earlier event; it increases database round trips. Claims are not renewed automatically, so configure `OUTBOX_LEASE_SECONDS` longer than the expected maximum time for a single delivery and monitor slow/repeated attempts.
- Delivery is **at least once**, not exactly once. A worker can persist notifications and then crash or lose its lease before acknowledgement. The next worker may invoke delivery again; inbox writes deduplicate by recipient and event key. Any future external push consumer must provide its own idempotency and cannot assume a lease prevents side effects after expiry. Do not expose or log lease tokens.
- Worker output is newline-delimited structured JSON. Failed-event records include only the event ID/type, attempt count, error class, and whether rescheduling succeeded; request payloads, tokens and raw exception messages are intentionally omitted. `retryScheduled: false` with no `retryScheduleErrorName` means the claim was no longer eligible for retry (for example, its lease was lost); a non-null `retryScheduleErrorName` means retry scheduling itself failed. Aggregate batch logs report claimed/delivered/failed counts. Queue-depth metrics, alert thresholds and external log shipping remain separate operations work.
- **Upgrade/rollback coordination:** stop and drain all old notification workers first. After an approved backup/release plan, apply the additive PostgreSQL migration `0010_outbox_lease_tokens` using the explicit migration command, then start only workers with the new code. Existing pending/delivered rows are preserved; previously leased rows become claimable when their existing `available_at` expires. Do not run old and new workers together: old workers can still acknowledge without a token. For rollback, stop all workers and assess the loss of fencing before restarting an older version; removing the column is not required for old code. No production migration is implied by this change.
- Message writes, recipient selection and inbox inserts serialize with membership edits and deletion using the conversation lock. This prevents a removed sender from writing after removal commits and prevents deletion from missing a late outbox event. The notification consumer resolves active members at **delivery time**, excluding the original sender even if they have left; a later joiner can receive an older pending message notification. A stale event after deletion creates nothing. Existing partial inbox deliveries are preserved and deduplicated; a payload conflict rolls back the new transaction. Old workers and API instances must be stopped before upgrade because they bypass this serialization. See [ADR 0009](../../docs/architecture/decisions/0009-message-notification-recipient-timing.md).

### Article persistence contract

Author profiles are stored with shared account-level avatar/website fields and per-locale display name/bio translations. User discovery supports localized display-name/ID search, following/follower lists, follower/following counts, and viewer-specific follow state. Follow and unfollow mutations derive the follower from JWT identity; a newly created follow writes an idempotent relationship and a durable `user.followed` notification in the same transaction; `updateMyProfile` derives the profile owner from the verified JWT. Published article results expose a nullable localized `author` profile when the owner has configured that locale. Articles are stored independently of the legacy MongoDB backend. Each article has one unique slug, author identity derived from verified JWT `sub`, draft/published state, and translated content rows keyed by `zh-TW` or `en`. Public list/detail queries return published content only; `myArticles` includes the authenticated owner's drafts. Article bodies are stored as validated JSON content blocks (`paragraph`, `heading`, `quote`, `list`, `image`, `code`) with a persisted `contentBlocksVersion`. Version 0 is the backward-compatible plain-text contract. Version 1 adds optional `inlines` arrays to text blocks and `itemInlines` arrays to list blocks; each run is `{ text, marks?, href? }`, marks are unique values from `bold`, `italic`, `underline`, `strikethrough`, and `code`, and concatenated run text must exactly equal the block/list-item plain-text fallback. Link URLs are limited to valid HTTP(S) URLs without credentials or site-root-relative paths; protocol-relative URLs, executable schemes, arbitrary HTML and unsupported node properties are rejected. A document is limited to 200 blocks, 1,000 inline runs per text/list-item entry, 50,000 characters per code block and 1,000,000 serialized characters. `contentBlocks` is returned as a JSON array by REST. Create/update operations enforce author ownership, reject duplicate slugs, and validate body shape before persistence. Category/tag records and their localized labels are persisted separately from articles. `createTag(name, locale)` supports user-created Unicode hashtags (including Traditional Chinese), strips a leading `#`, normalizes full-width/case variants, generates a stable collision-resistant slug, and reuses the same global tag across users instead of giving each user a private tag. Tag reuse and article association are open to any authenticated author; tag labels are not overwritten by later duplicate creates. The legacy `createTaxonomy(kind: "category", ...)` category path remains creator-scoped.  article-to-taxonomy links are replaceable transactionally during article creation/update, public taxonomy queries filter to published articles in the requested locale, and default-language labels are used as a display fallback. Taxonomy edits and deletion are limited to the creating user pending role-aware administrative policy. Authenticated `likedArticles` returns only the viewer's liked, published articles that have the requested translation. `relatedArticles` ranks other published articles in the requested locale by shared category/tag links, then same author and recency. `setArticleLike` is a retry-safe, idempotent like/unlike operation; `toggleArticleLike` remains available for compatibility. A newly created like writes a durable `article.liked` notification for the author in the same transaction, except when the author likes their own article. New comments notify the article author, and replies notify the parent comment author; the comment and its notifications commit atomically. Article likes are unique per user and article; their toggle operation locks the published article row to serialize concurrent toggles. Comment threads are stored as a parent-child relation with cascading reply deletion; public reads expose only published articles in the requested locale, and comments can only be deleted by their author.

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

The API exposes a versioned REST business contract under `/api/v1`. REST handlers call the shared application-service facade and do not access PostgreSQL directly. All REST JSON responses use `Cache-Control: no-store`. Private endpoints derive the acting user exclusively from a verified bearer JWT, reject revoked sessions and never accept client-supplied actor/owner IDs.

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
- `POST /api/v1/articles/:slug/comments` — create a comment or reply. Legacy requests keep `content` plain text (version 0); alternatively send exactly one of `contentBlocks` or write-only serialized Lexical `editorState` (version 1). Version 1 permits paragraph-only blocks with bold, italic, underline, strikethrough, inline code and safe HTTP(S) or site-root-relative links; images, headings, lists, code blocks and unsupported Lexical metadata are rejected. The server derives the author from JWT, and the plain-text `content` fallback must match the versioned blocks exactly.
- `POST /api/v1/articles` — create an article. Accepts an optional `Idempotency-Key` header (1–300 trimmed characters): a retry with the same key and the same request returns the work the first attempt published rather than a second copy under a uniquified slug, and reusing the key with a different work returns `409 IDEMPOTENCY_CONFLICT`. The key is optional only because the authoring desk does not mint one yet. Body fields: `slug`, `title`, optional `summary`, `locale` (`zh-CN`, `zh-TW`, or `en`), exactly one of `contentBlocks` (application JSON array) or write-only `editorState` (serialized Lexical state), optional `contentBlocksVersion` (`0` by default for `contentBlocks`; `1` for rich text or any `editorState` ingress), `publish`, `workType`, `categoryIds` and `tagIds`. The author is derived from JWT identity; storage and responses use application-owned blocks, never raw Lexical JSON.
- `PUT /api/v1/articles/:articleId` — update an article; the actor is derived from JWT and ownership is enforced in the application/persistence layer. Uses the same fields as create, and requires boolean `publish`.
- `PUT /api/v1/me/profile` — update the current user's profile using `displayName`, optional `bio`, `avatarUrl`, `websiteUrl` and optional `locale`. The profile owner is derived from JWT identity.
- `POST /api/v1/users/:userId/follow` and `DELETE /api/v1/users/:userId/follow` — idempotently follow or unfollow the target stable user ID. The returned profile includes the complete AuthorProfile data contract, including counts, timestamps, avatar/website, locale and viewer-specific follow state.
- `DELETE /api/v1/me/session` — revoke the self-hosted session family associated with the verified access token; for external JWTs revoke only the presented `jti`.
- `POST /api/v1/tags` — create or reuse a normalized hashtag; the actor is derived from JWT.
- `POST /api/v1/taxonomies` and `DELETE /api/v1/taxonomies/:taxonomyId` — create/delete a localized category or taxonomy; deletion is creator-scoped.
- `POST /api/v1/conversations` — create a conversation with the authenticated actor plus submitted participants. Requires an `Idempotency-Key` header (1–300 trimmed characters): a retry reopens the conversation the first attempt created instead of leaving a second conversation that quietly stops being answered, and reusing the key with different participants returns `409 IDEMPOTENCY_CONFLICT`.
- `POST /api/v1/conversations/:conversationId/messages` — send a message with a required `Idempotency-Key` header and JSON body `{"body":"..."}`. The sender is JWT-derived; persistence commits the message and transactional outbox intent together.
- `GET /api/v1/conversations/:conversationId` — one conversation as one of its members sees it (participants, last activity, unread count, last message). A conversation the caller is not an active member of is `404 NOT_FOUND`, because membership is the only way to learn that it exists.
- `PATCH /api/v1/conversations/:conversationId/participants` — manage participants under the existing creator/member rules and return the complete Conversation.
- `PUT /api/v1/conversations/:conversationId/read` and `DELETE /api/v1/conversations/:conversationId` — update the current participant's read state or delete a conversation under creator/member rules.
- `PUT /api/v1/me/notifications/:notificationId/read` and `POST /api/v1/me/notifications/read-all` — recipient-scoped single/batch read-state updates; batch response is the changed-row count.
- `PUT /api/v1/articles/:slug/like?locale=zh-CN` — set an explicit like state with JSON body `{"liked": true}` or `{"liked": false}`. This is retry-safe state setting rather than a toggle.
- `POST /api/v1/articles/:slug/comments?locale=zh-CN` — create a comment or reply with `{"content": "...", "parentCommentId": null}`; replies must reference a comment on the same article. Supplying an optional `Idempotency-Key` (1–300 trimmed characters) makes a retry with the same normalized request return the same persisted comment and avoids duplicate comment notifications; reusing the key with a different request returns `409 IDEMPOTENCY_CONFLICT`. Only a SHA-256 key digest is stored, not the raw header. The full contract — which routes require a key, how digests and fingerprints are computed, and what a replay returns — is in [docs/architecture/rest-idempotency.md](../../docs/architecture/rest-idempotency.md).
- `DELETE /api/v1/comments/:commentId` — delete the current user's own comment. Returns `{"data":{"deleted":true}}` when deleted; the domain layer enforces ownership.

### Validation and error behavior

Repeated query parameter names are rejected with `400 BAD_USER_INPUT` because all current REST query parameters are scalar; rejected requests close the connection when a write body may remain unread. The versioned REST API accepts locales `zh-CN`, `zh-TW`, and `en`; unsupported locales return `400 BAD_USER_INPUT` instead of silently falling back. Article responses include the complete documented article data contract, enriched with `author`, `categories`, and `tags` from the shared services. REST `contentBlocks` is a JSON array. Search terms are limited to 200 characters. Pagination limits are integers from 1 to 100 with bounded non-negative offsets. Domain validation, ownership rules, transactions and notification-outbox behavior remain in the existing application and persistence layers. Errors are mapped to stable HTTP codes and sanitized messages.

This remains a staged migration. The article rich-text contract is application-owned and versioned; Lexical JSON and client-supplied HTML are not accepted as canonical content. The current version-1 scope includes inline marks and hyperlinks inside existing block types. A pure serialized-Lexical adapter supports paragraphs, h2–h4 headings, quotes without attribution, ordered/unordered lists, inline text/link/marks, and code. It rejects custom image nodes, quote attribution, nested lists, unsupported CSS/alignment/direction metadata, and other payload features that the application contract cannot preserve; comment rich text and approved media upload integration remain open tasks. The REST-only migration is complete. The historical parity audit records the previous GraphQL operation inventory and the intentional move from a non-idempotent like toggle to explicit `PUT liked` state-setting semantics. Taxonomy, conversation/message and notification routes reuse the existing persistence authorization, cursor, idempotency and outbox behavior. Request-level REST tests and the full CI gate now validate the supported contract.


## Cross-provider live-migration boundary

The product direction is SQLite-first while retaining PostgreSQL and adding MongoDB as an adapter. Online migration/cutover is a separate capability, not something that happens by changing `DATABASE_PROVIDER`: the source must remain the single write authority while a consistent snapshot and ordered change stream are applied idempotently to the target, validated to a watermark, then fenced and switched. Reverse replication/rollback, delete tombstones, schema versions, lag monitoring and split-brain prevention must be tested before advertising live switching. This change enables the SQLite runtime and provider-specific migrations; it does not yet implement cross-engine replication or the MongoDB adapter.

