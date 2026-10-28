# Persistence-provider and online data-migration plan

## Scope and product boundary

The current repository is an independent implementation, not a code-preserving refactor. The previous BOT THK project is used to identify product capabilities, user-visible behavior, data concepts, and known defects. Its programming patterns, database schema, resolver structure, and UI layout are not binding design constraints.

SQLite is the default provider for fresh/local installs. PostgreSQL is retained as an optional adapter and MongoDB is a planned adapter. REST is the target business API; GraphQL must be removed after the remaining Web caller is migrated, and no new GraphQL work is allowed. Domain-grouped repository ports isolate database drivers so all registered providers can implement equivalent behavior. This document defines the online migration target but does **not** copy production data, run cross-engine replication, switch live traffic, or modify the previous project's repository.

Product behavior changes must be reviewed: when an improvement would change user-visible behavior, authorization policy, destructive lifecycle rules, compatibility guarantees, or data semantics, present the options, impact and recommendation and obtain approval before committing the behavior change.

## New-project environments

- **Local development/default:** use SQLite at `./data/no-wave.sqlite`; `DATABASE_PATH` overrides the location. Run `pnpm --filter @bot-thk/api migrate` before `pnpm --filter @bot-thk/api start`.
- **Optional PostgreSQL:** set `DATABASE_PROVIDER=postgres` and `DATABASE_URL`, then use the same explicit migration command.
- **MongoDB:** not yet available; selecting it fails explicitly without falling back to another engine.
- **Integration tests:** use `TEST_DATABASE_URL` with a disposable database. The suite can create versioned schema and writes uniquely identified fixtures that it cleans up. Never point it at production or user data.
- **CI:** a dedicated PostgreSQL service and throwaway database run the integration tests.
- **Production:** secrets, TLS, backup schedule, retention, monitoring and process supervision remain release decisions. They are not hard-coded into source.

API startup does not silently execute migrations. Schema changes run as an explicit release step.

## Current persistence responsibilities

The provider-independent contract covers conversations/participants/messages, notification inbox and outbox, revoked sessions, article/localized content blocks, user profiles, dynamic taxonomy/tag associations, article likes/comments, and follows. PostgreSQL implements the relational schema; SQLite is the default registered adapter. MongoDB remains unimplemented and must not be represented as a supported switch target yet.

The database is a new system of record. It is not currently wired to the legacy MongoDB database and no current feature depends on reading or writing both systems.\n\n## Provider migration journal foundation\n\nSQLite and PostgreSQL now have versioned tables and storage primitives for migration sessions, ordered change envelopes, replay checkpoints, and an idempotent applied-change ledger. Appending a change and marking it applied must happen inside the same transaction as the corresponding source or target domain mutation. A stable unique transaction ID groups all journal records produced by one source transaction; replay batches never split such a group, and the target checkpoint advances in the same transaction as the applied-change ledger.\n\nThis infrastructure now includes opt-in transactional instrumentation for selected domain writes in the SQLite and PostgreSQL stores: articles and article-taxonomy links, taxonomies, profiles and follows, likes and comments, conversations and participants, messages/outbox creation, conversation-deletion tombstones, and notification creation/delivery/read-state changes. Capture is append-only, grouped by source transaction ID, and committed with the corresponding business write. Coverage is now broader but still must be audited against every write path and any direct SQL bypass. The target entity replayer, consistent snapshot/watermark coordination, reconciliation, writer fencing, cutover and rollback are not implemented. The journal can contain password hashes and refresh-token hashes during active capture, but not plaintext passwords or raw refresh-token secrets; treat it as credential-sensitive data and define access controls and retention before production capture.

## Optional future historical-data import

If importing existing user/content data is desired, treat that as a separately approved project phase rather than an automatic part of application development:

1. Inventory source collections, indexes, identifiers, relationships, publication states, content formats, timestamps, PII and retention requirements.
2. Confirm which records and histories should be imported, and agree on mappings and conflict handling.
3. Create a consistent, access-controlled source snapshot and verify its restoration in an isolated environment.
4. Build a deterministic transform for approved entities only. Preserve original identifiers as explicit source-reference fields where useful; do not silently copy credential material or token logs.
5. Dry-run into an isolated PostgreSQL instance and compare counts, uniqueness, relations, publication visibility and representative records. Record rejected rows in a redacted exception report.
6. Decide whether the new product starts with clean data or imports a snapshot. If live writes must be carried over, design a separate synchronization/freeze/cutover protocol and test it explicitly.
7. Obtain approval before connecting production credentials, importing production data, redirecting traffic or deleting any source data.

A new-app release does not require the old implementation to remain active indefinitely. Conversely, rebuilding functionality does not by itself authorize importing historical data or redirecting live traffic.

## Operational acceptance checklist

- [ ] Database credentials come from environment/secret management and are never committed.
- [ ] TLS, least-privilege roles, connection bounds, timeouts, backups, restoration and retention are configured for any production deployment.
- [ ] Migrations are reviewed and applied once per release; startup does not silently modify schemas.
- [ ] Monitoring covers connection saturation, migration failures, outbox backlog/retries and persistence errors.
- [ ] Message writes and outbox intent commit atomically; idempotency keys and notification event keys have explicit uniqueness rules.
- [ ] Private resolvers authorize against authoritative records before returning or mutating data.
- [ ] Historical import and traffic cutover have separate written acceptance plans and explicit approval.
- [ ] Rollback accounts for writes made after the new system becomes authoritative.

## Online cross-provider migration and switching

The project goal is a near-zero-downtime move between supported engines, not an unsafe configuration-only swap. Until the synchronization pipeline is implemented, exactly one engine is authoritative for writes and `DATABASE_PROVIDER` only selects the adapter on process startup.

The eventual cutover must:
1. Create a consistent source snapshot and assign a schema/contract version.
2. Capture every committed change in a durable, ordered journal or engine CDC feed, including deletes/tombstones and outbox state.
3. Apply changes idempotently to the target using stable IDs and per-entity or global checkpoints; do not use independent synchronous dual writes.
4. Reconcile counts, unique constraints, relations, content hashes and representative business journeys while monitoring lag.
5. Fence source writes, drain the stream to a verified watermark, atomically switch all API and worker processes, then verify reads and writes against the new authority.
6. Keep a rollback plan. Once target-only writes are accepted, rollback requires reverse change capture or a controlled maintenance window; changing the environment variable alone is not rollback.
7. Record operator, source/target IDs, watermarks, counts and validation outcomes without recording credentials or user secrets.

SQLite WAL is same-host; it is not a cross-host HA mechanism. PostgreSQL remains available for deployments requiring relational server semantics. MongoDB must implement the full adapter and transaction/outbox capability contract before it can be selected. RPO/RTO, automatic promotion and active-active writes remain out of scope for this initial runtime-provider change.

See ADR 0005 for provider boundaries and ADR 0010 for the accepted SQLite-first decision.
