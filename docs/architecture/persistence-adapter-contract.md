# Persistence Adapter Behavioral Contract

This is the acceptance contract for every persistence provider in the rebuilt BOT THK API. An adapter is not considered supported merely because it connects and implements methods with matching names. It must pass the same observable domain tests.

## Dependency direction

`GraphQL/HTTP → application services → domain-grouped persistence ports → provider adapter`

The current operation lists live in `apps/api/src/application/persistence-ports.ts`. Domain types, validation and policy live under `apps/api/src/domain/`. Driver-specific row mapping, query syntax, index definitions, transactions and connection handling stay inside the provider adapter.

## Typed port boundary and provider composition

`persistencePortMethods` remains the single source of truth for method names. Alongside it, `TypedPersistenceAdapterContract` declares one explicit input and output signature per method, grouped into the same eleven domain ports. `PersistenceAdapterContract` is that type; `PersistencePorts` and `ApplicationServices` default to it. `PersistenceAdapterMethods` is `Record<string, (...args: never[]) => unknown>` — there is no `(...args: any[]) => any` fallback, so a `satisfies` check cannot be forged with `as unknown as`. `apps/api/src/application/persistence-ports.contract.ts` holds compile-time `@ts-expect-error` guards (wrong name, wrong type, wrong enum value, wrong arity, missing required field/result field, missing method, wrong adapter slice result, media outside the REST port table) and is compiled by CI's `pnpm typecheck`.

Inputs now describe what the stores actually validate: genuinely required fields are required, and the REST layer normalizes bodies into named types (`ArticleWriteBody`, `ProfileWriteBody`) instead of spreading a `Record<string, unknown>`. Results are the shapes both providers really return — `deleteTaxonomy`/`followUser`/`unfollowUser`/`deliverMessageNotifications` are booleans, unread counts and batch read counts are numbers, `setUserRole` returns a string, `createNotification` returns a receipt with `duplicate`, `createNotifications` returns one such receipt per input in input order (one transaction for the whole batch, so a conflict rolls all of it back — the deletion notices of audit F-23 depend on that), inbox rows have `readAt`, and outbox leases keep their driver-level snake_case columns (with `available_at` normalized to the same ISO string in both providers). `PersistenceResult<T> = T | Promise<T>` models the synchronous SQLite slices and asynchronous PostgreSQL slices without changing behavior; identity, sessions, rate limits, media and `health` are async in both providers and keep the narrower `Promise<T>`.

Both providers follow the same slice layout. SQLite composes `sqlite-*-store.ts`; PostgreSQL composes `postgres-*-store.ts` from `postgres.ts`, which only owns connection-pool creation, the transaction helper and composition. Shared PostgreSQL row mappers, SQL helpers and the migration-capture context live in `postgres-shared.ts`. `postgres-identity-store.ts` remains the identity slice for both session revocation and rate limiting.

The PostgreSQL driver boundary is typed in `postgres-driver.ts`: `PgDatabase`, `PgTransaction` and `PgExecutor` are narrow structural interfaces that the real `postgres.Sql` satisfies (checked by `pnpm typecheck` at the one call site where a real client enters, `createPostgresStore`). There is no `any` on `sql` or `tx`, no `as unknown as` in the slices, and no `any` fallback in the adapter contract. Only column *values* remain dynamic, via the driver's own `postgres.Row`; mapping them into typed domain records is each slice's job.

`updateConversationParticipants` now returns the resulting active participant id list in **both** providers. The PostgreSQL slice re-reads membership inside the same write transaction instead of returning `true`; the REST route still re-reads the conversation, and `persistence-ports.contract.ts` rejects a boolean result at compile time. See `docs/architecture/persistence-slices.md` for the checked-in slice manifest/generator and the first-round split baseline.

Every domain store — all ten SQLite slices and all ten PostgreSQL slices — ends with `satisfies Pick<TypedPersistenceAdapterContract, ...>` naming exactly its own methods, so a renamed parameter, a wrong result field or a wrong result type fails the build in either provider. Both compositions use one object literal checked with `satisfies TypedPersistenceAdapterContract`, retained `assertPersistenceAdapter`, and added `assertDisjointSlices` plus a compile-time pairwise-overlap check to prevent a later slice from silently overriding an earlier method. The SQLite composition deliberately takes only `isSessionRevoked` from the session slice (the identity slice owns `revokeSession`). Media metadata stays out of `persistencePortMethods` but is typed on the full adapter; `transaction` is optional and PostgreSQL-only.

## The transport boundary, and where `any` is still possible

The ports were the first untyped boundary; the REST response projections were the second. `transport/rest/serializers.ts` used to be `any` in and `any` out, which meant the one place every response shape is decided was the one place the compiler could not look: reading `article.authors` instead of `article.author` compiled, and shipped JSON with a hole in it. Those functions are now generic over the stored record and answer `A & RestArticleProjection`, with the projection types derived from the persistence contracts; the tolerant pass-through behaviour (a non-object in a list is returned untouched) survives as `unknown` overloads. `serializers.test.ts` asserts the result is neither `any` nor `unknown` at compile time, because a runtime assertion cannot see a type.

`apps/api/src/typed-boundaries.test.ts` bans the type-position spellings of `any` in every non-test source file under `apps/api/src`, comments stripped first. The patterns are `: any`, `as any`, `<any>`, `any[]`, `Array<any>` and `Record<string, any>` — the word itself may appear in prose, and the files that removed a cast explain why at length. Where a cast is genuinely the boundary, it is now a documented one: `checkedAdapter` in `persistence-runtime.ts` (after the runtime method check), one recursion assertion in `serializers.ts` (the stored comment contract says a reply is a comment), and the driver rows in `postgres-driver.ts`/`sqlite-provider-migration-journal.ts`, which read column values through `text()`/`seq()` readers that name the offending column instead of letting a `NULL` become a typed field.

**`strict` is on, in all four packages.** `apps/api/tsconfig.json` used to be the one project with `"strict": false`, which turned off `noImplicitAny` and `strictNullChecks` for the package that owns every SQLite and PostgreSQL slice; `packages/web-ui`, `packages/web-http` and `apps/web-rr` were already strict. Flipping it was 523 errors, so the migration ran slice by slice — the pure domain first, then the typed seams, then each store — rather than as one cleanup commit. It is now `"strict": true` in `apps/api`, the staging project `apps/api/tsconfig.strict.json` is gone (it existed only to typecheck a subset), and `pnpm typecheck` is one strict project per package.

The errors were not noise; each class was a missing decision, and the decisions are now in the code:

- **`strictNullChecks` over database rows.** `node:sqlite` answers a row bag whose column values are dynamic, and `postgres.js` answers the same. That is named once per provider — `postgres.Row`, and `SqliteRow` in `persistence/sqlite.ts` — and `typed-boundaries.test.ts` exempts exactly those two aliases (a second test fails if the SQLite exemption grows or rots). Everything downstream of a row is annotated: mappers take `SqliteRow`/`PgRow` and answer a declared record, and a writer's read-back of a row it just wrote goes through a helper that throws on a missing row (`one()` in the SQLite slices, `readArticleForAuthorOrThrow` in `postgres-shared.ts`) instead of widening the result to `T | null` and pushing the check into every caller.
- **Optional-capture arrays.** A migration-journal change array is `CapturedChange[]`, so `operation: "upsert"` stays the enum rather than widening to `string` inside a `.map()` callback.
- **`unknown` catch bindings.** A writer that branches on the driver's unique-violation class does so through `isUniqueViolation(error)` (PostgreSQL `23505`) or an `error instanceof Error` message read, never through `error.code` on an undeclared `any`.
- **Optional-parameter contract checks.** The `transaction` provider method is annotated on its own signature, so `satisfies TypedPersistenceAdapterContract` checks it instead of inferring `any`.

Two defects fell out of the migration rather than being looked for: `listTaxonomyArticles` returned article records without `contentBlocksVersion` (it never selected the column; the contract required it), and the SQLite outbox claim returned only three of the eight `StoredOutboxEvent` fields, which the untyped shape had been hiding from the worker contract.

## Required adapter contract

### Article content and publication

- Creating an article derives `authorId` from the authenticated application use case, never from a client-supplied author.
- A slug is globally unique within the agreed product scope; duplicate create fails with a stable conflict error.
- A keyed article create persists its idempotency and request digests with the article. Journal replay carries both nullable fields, so an identical retry after replay returns the same work without restoring it if tombstoned, and a conflicting retry is rejected; it never carries the raw key.
- Article body block validation is identical across providers. Invalid block IDs/types, duplicate block IDs, invalid heading levels, invalid media URL protocols and oversized content are rejected before persistence.
- Drafts are visible only to the owner-authorized operation; public list, detail and taxonomy queries return published content only.
- Localized translations are keyed by `zh-TW` or `en`; a missing requested translation is not silently represented as another language's content. Display fallback is allowed only where the domain contract explicitly specifies it.
- Update changes, publication state and taxonomy associations are atomic. If any association fails, no partial article update is retained.
- Article-media references and nullable avatar references are replayed transactionally from versioned incremental snapshots; missing dependencies fail closed. Tombstones retain references and hard deletion cascades them. Existing uncoordinated media baselines are rejected, not repaired. See [media replay limits](provider-migration-media-references.md); provider cutover remains prohibited.
- Deleting a work is a tombstone, not a row removal: `deleted_at` is stamped, the status returns to `draft` so every published read already excludes it, and the row keeps the comments, likes and taxonomy links that refer to it. A tombstone is invisible to every read — public lists, the author's own desk, likes and related works — and it can be neither updated nor deleted a second time (both are a not-found). Deletion releases the slug, so rewriting the same title cannot collide with the tombstone.
- A tombstone is recoverable and finite. `listMyDeletedArticles` returns the author's own tombstones newest-deletion-first, each carrying its `deleted_at` and the number of comments still attached to it (`commentCount`) — the sweep takes those comments with the work, and the count is part of the listing because the cost of a deletion is borne by the people who commented, not only by the author; `restoreArticle` clears it and returns the work as a **draft** (never as published — deleting withdrew it, and republishing is the author's decision to make again), reclaiming the released slug when nothing else has taken it since and keeping the tombstone's own slug when something has, so a restore never fails over an address the author cannot see. Authorization and not-found rules mirror deletion exactly: not the author is an authorization error, and a live work, an unknown id and a second restore are all a not-found.
- `purgeExpiredArticles({ retentionDays, now, limit })` hard-deletes tombstones strictly older than the retention window, bounded by `limit`, and captures the article, translation, like, comment and taxonomy-link deletions in the provider-migration journal. It is the only irreversible step in the slice, so it is reachable from a bounded sweep and never from an author-facing action: the desk has no "delete forever" button. The window is service-layer policy (`ARTICLE_TOMBSTONE_RETENTION_DAYS`, default 30 days, an out-of-range value falls back to the default rather than clamping), which is why `purgesAt` is computed in the service and not in the stores. Other capture and replay gaps remain; see [ADR 0010](decisions/0010-sqlite-first-and-online-provider-cutover.md#current-implementation-state) before considering any provider migration.
- Restore and purge serialize on the tombstone: if restore commits first, a concurrent sweep cannot delete that restored work or a subsequent fresh tombstone; if purge wins, restore reports not found. Concurrent sweeps count and journal a claimed article only once. PostgreSQL skips locked candidates so other eligible work can progress; a skipped tombstone remains eligible for a later sweep. SQLite serializes these writes in its write transaction.
- `listArticleCommentAuthorIds({ articleId, limit })` returns everyone who has commented on a work, once each, ordered by their first comment and bounded by `limit`. Deleting a work eventually deletes its comments, and those are other people's words: the service layer uses this list to write each commenter one notification naming the date the sweep will remove them. There is no scheduler that could warn them later, so the deletion itself is the only moment the system can reach them; a failure to notify never fails the deletion.

### User-generated hashtags and categories

- Hashtags are data, not a compiled enum or fixed seed list.
- Hashtag normalization is shared domain code: apply Unicode NFKC normalization, accept an optional leading `#`, reject whitespace/embedded markers and unsupported punctuation, keep Unicode display text, and derive one stable normalized identity.
- Repeated create of an equivalent hashtag returns the same tag and never overwrites another user's existing label.
- A tag created by one user can be reused and attached by another authenticated author; association operations remain owner-scoped to the article being edited.
- Tag listing and tag detail count/list published articles only, and honor requested locale rules.
- Category authorization/deletion semantics remain distinct from hashtag reuse until a product decision explicitly changes them.

### Profiles, follows and engagement

- A user cannot edit another user's profile or delete another user's comment.
- A user cannot follow themselves; repeated follow/unfollow requests are idempotent.
- Like/unlike has deterministic state-setting semantics. Retrying the same desired state must not flip state.
- One user has at most one logical like per article; counts and viewer state match stored relationships.
- Comment replies must belong to the same article as their parent. Deleting a parent applies the defined cascading deletion rule.
- Durable notification records created as part of a mutation must commit in the same transaction as that mutation, where the current product behavior promises atomicity.

### Conversations and messages

- Only verified participants can read history, send messages, manage participants or change read state where those operations are allowed.
- Sender identity is derived from authenticated context, not request payload.
- Message write, idempotency record and outbox intent commit atomically. Serialize the membership check and message/outbox insert with participant changes and conversation deletion, so a removal committed first denies the sender and deletion cannot leave a late orphan event.
- Retrying the same idempotency key and payload returns the original logical message. Reusing it with another payload returns `IDEMPOTENCY_CONFLICT`.
- Bounded cursor pagination returns older messages for a cursor belonging to the same conversation; malformed or foreign cursors fail predictably.
- A participant removal must not accidentally delete other users' message history unless a product-level deletion rule is explicitly approved.

### Notifications, sessions and outbox

- Notifications are recipient-scoped; another user cannot list, mark or infer private inbox state.
- Event keys deduplicate logical notifications across delivery retries; a key reused with different payload content is rejected.
- Unread counts and batch read updates are scoped to the current actor.
- Message notification delivery selects the current active members, excluding the original sender even if they have left. Under one transaction, serialize recipient selection and all inbox inserts with membership changes and conversation deletion. A stale deleted-conversation event is a no-op; an existing conflicting payload rolls back the whole delivery. Older partial inbox rows remain idempotent.
- Session revocation is durable until the signed token expires; adapter health or transient errors must never cause a revoked token to be accepted.
- Self-hosted account creation and its initial session commit together. Refresh token rotation, replay detection and logout serialize on the session; a reused token or logout revokes all access IDs and refresh credentials in that family. Persist only salted password hashes and token digests, not raw credentials. Rate-limit increments are atomic and durable; expired identity-state pruning is bounded and must not delete active or recently expired sessions.
- An address change invalidates its previous verification and recovery tokens in the same transaction. Token issuance checks the current address; the final verification or reset checks its consumed, purpose- and account-bound proof under the same transaction as the change. A rejected reset cannot change the credential or revoke sessions. The incremental migration journal records these changes and tombstones atomically, subject to the [identity replay limits](provider-migration-identity-featured.md).
- Outbox claiming supports concurrent workers without claiming one active lease as if it belonged to multiple workers. Each claim must issue a fresh token; acknowledgement and retry must atomically verify the matching, unexpired lease after acquiring any relevant lock. A released, expired or superseded token must not mark an event delivered or delay another worker's claim. Failed deliveries can be rescheduled and recovered, while consumers deduplicate at-least-once delivery.
- Dispatchers should claim immediately before delivery rather than leasing an entire sequential batch while later leases expire. A worker upgrade must stop old token-unaware workers before the additive migration; mixed versions cannot provide fencing.
- The adapter must preserve the required atomicity of the outbox event and its source mutation.

### Errors and operational behavior

- Domain failures map to stable application error codes independent of the provider's native error text/code.
- Raw SQL/driver messages, connection strings and credentials are never exposed in GraphQL errors or unauthenticated health probes.
- `health()` must test the actual persistence dependency; it must not report ready when the selected database is unavailable.
- Runtime provider selection is explicit. An absent/unavailable adapter is a startup error, not a reason to silently choose another database.

## Provider-specific test suites

Each adapter needs:

1. Adapter-shape tests using `assertPersistenceAdapter`.
2. The applicable behavioral contract tests above against disposable resources.
3. Concurrency tests for uniqueness/idempotency, membership/ownership and outbox leases.
4. Failure tests for transaction rollback and connection loss.
5. Migration/index and clean-start tests.
6. A documented capability table for transaction semantics, concurrency limits, native replication, backup/restore and deployment topology.

PostgreSQL is the current reference adapter. MongoDB and SQLite must not be called supported until their adapter implementations, provider runtime factory and these behavioral tests all pass. SQLite is initially targeted at local/test/single-host use; its single-writer and WAL topology constraints must be reflected in the deployment policy.

## Cross-engine replication is a separate contract

A provider adapter controls persistence semantics for one authoritative database. Replication across PostgreSQL and MongoDB is a separate service with its own acceptance criteria:

- One write authority at a time; the mirror is read-only until a fenced promotion.
- Each replicated change has a stable event ID, aggregate ID/type, monotonic version or ordered source position, schema version, payload and deletion/tombstone semantics.
- The event is durably recorded with the source transaction (transactional outbox or database CDC with a proven checkpoint boundary).
- Consumers are idempotent, maintain a durable checkpoint, tolerate at-least-once delivery and can replay safely.
- Lag is measured and visible. Reconciliation compares version/count/checksum samples, including deleted records and localized rows.
- Failover has a written RPO/RTO, promotion rule, fencing/lease/quorum policy, and a rejoin/reconciliation runbook before automation is enabled.
- A failed database is not automatically promoted by app-level connection fallback alone; this does not prevent split brain.

Bidirectional replication and independent writes on both engines are out of scope until a separate conflict-resolution and distributed-consistency protocol is approved.
