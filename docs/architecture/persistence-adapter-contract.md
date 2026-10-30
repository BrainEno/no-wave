# Persistence Adapter Behavioral Contract

This is the acceptance contract for every persistence provider in the rebuilt BOT THK API. An adapter is not considered supported merely because it connects and implements methods with matching names. It must pass the same observable domain tests.

## Dependency direction

`GraphQL/HTTP → application services → domain-grouped persistence ports → provider adapter`

The current operation lists live in `apps/api/src/application/persistence-ports.ts`. Domain types, validation and policy live under `apps/api/src/domain/`. Driver-specific row mapping, query syntax, index definitions, transactions and connection handling stay inside the provider adapter.

## Required adapter contract

### Article content and publication

- Creating an article derives `authorId` from the authenticated application use case, never from a client-supplied author.
- A slug is globally unique within the agreed product scope; duplicate create fails with a stable conflict error.
- Article body block validation is identical across providers. Invalid block IDs/types, duplicate block IDs, invalid heading levels, invalid media URL protocols and oversized content are rejected before persistence.
- Drafts are visible only to the owner-authorized operation; public list, detail and taxonomy queries return published content only.
- Localized translations are keyed by `zh-TW` or `en`; a missing requested translation is not silently represented as another language's content. Display fallback is allowed only where the domain contract explicitly specifies it.
- Update changes, publication state and taxonomy associations are atomic. If any association fails, no partial article update is retained.
- Deleting a work is a tombstone, not a row removal: `deleted_at` is stamped, the status returns to `draft` so every published read already excludes it, and the row keeps the comments, likes and taxonomy links that refer to it. A tombstone is invisible to every read — public lists, the author's own desk, likes and related works — and it can be neither updated nor deleted a second time (both are a not-found). Deletion releases the slug, so rewriting the same title cannot collide with the tombstone.
- A tombstone is recoverable and finite. `listMyDeletedArticles` returns the author's own tombstones newest-deletion-first, each carrying its `deleted_at`; `restoreArticle` clears it and returns the work as a **draft** (never as published — deleting withdrew it, and republishing is the author's decision to make again), reclaiming the released slug when nothing else has taken it since and keeping the tombstone's own slug when something has, so a restore never fails over an address the author cannot see. Authorization and not-found rules mirror deletion exactly: not the author is an authorization error, and a live work, an unknown id and a second restore are all a not-found.
- `purgeExpiredArticles({ retentionDays, now, limit })` hard-deletes tombstones older than the retention window, bounded by `limit`, and captures the deletion of the article row and of every row the foreign keys remove (translations, likes, comments, taxonomy links) into the provider-migration journal — the journal, not the cascade, is what a replica replays. It is the only irreversible step in the slice, so it is reachable from a bounded sweep and never from an author-facing action: the desk has no "delete forever" button. The window is service-layer policy (`ARTICLE_TOMBSTONE_RETENTION_DAYS`, default 30 days, an out-of-range value falls back to the default rather than clamping), which is why `purgesAt` is computed in the service and not in the stores.

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
- Self-hosted account creation and its initial session commit together. Refresh token rotation, replay detection and logout serialize on the session; a reused token or logout revokes all access IDs and refresh credentials in that family. Persist only salted password hashes and refresh-token digests, not raw credentials. Rate-limit increments are atomic and durable; expired identity-state pruning is bounded and must not delete active or recently expired sessions.
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
