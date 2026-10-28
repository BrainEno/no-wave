# ADR 0010: SQLite-first persistence and online provider cutover

- Status: Accepted
- Date: 2026-10-28
- Supersedes: ADR 0004 for default-provider priority; preserves PostgreSQL as a supported adapter

## Context

The project needs to work locally with minimal infrastructure, while retaining a path to PostgreSQL and MongoDB deployments and the ability to move between providers without treating database selection as a data migration. The codebase already has provider-independent persistence ports, a composed SQLite adapter and a PostgreSQL adapter. MongoDB is not yet implemented. The previous plan made PostgreSQL the only runtime provider and deferred SQLite despite its store/contract test coverage.

The product owner has also confirmed that REST is the sole business HTTP API and GraphQL must be completely removed. The remaining Web GraphQL caller is tracked as a separate Web-focused migration; no new GraphQL features or fields should be added while that removal is pending.

## Decisions

1. **SQLite is the default for fresh/local installs.** Use `DATABASE_PATH` (default `./data/no-wave.sqlite`). Local database files, WAL files and SHM files must not be committed. Migrations are explicit by default; startup refuses an uninitialized or stale SQLite schema. `DATABASE_AUTO_MIGRATE=true` is an explicit local/test convenience, not a production release policy.
2. **PostgreSQL remains supported.** Select it with `DATABASE_PROVIDER=postgres` and `DATABASE_URL`. For backwards compatibility, a pre-existing environment that sets `DATABASE_URL` but no `DATABASE_PROVIDER` continues to select PostgreSQL rather than silently switching to a new SQLite database.
3. **MongoDB remains a target adapter, not an available provider yet.** It may be selected only after every persistence port, transaction/outbox guarantee, migration path and shared behavioral contract passes. Unsupported providers fail closed; they never fall back to another engine.
4. **REST is the only target business HTTP API.** GraphQL is removal-only transition code. Do not add operations to it; remove the schema, route, Yoga packages, configuration and obsolete GraphQL tests after the remaining Web caller migrates to REST. Backend-only provider changes do not modify `apps/web/`.
5. **A provider setting is not an online data cutover.** The goal is an online/near-zero-downtime migration capability across SQLite, PostgreSQL and MongoDB, but it must use a controlled protocol with one authoritative writer at a time:
   - take a consistent source snapshot and tag it with a schema/contract version;
   - capture committed changes in an ordered durable journal or engine change-data-capture stream, including deletes/tombstones and outbox state;
   - apply changes idempotently to the target using stable IDs and durable checkpoints;
   - reconcile counts, relationships, unique constraints, content hashes and representative business journeys while observing replication lag;
   - fence source writes, drain through a verified watermark, atomically switch the API and all workers, and verify operations against the target authority;
   - retain an explicit rollback strategy. After target-only writes begin, rollback requires reverse change capture or a controlled maintenance window.
6. **Do not use synchronous dual writes as a shortcut.** Partial success across unrelated engines can create divergence. The active engine remains the sole write authority during backfill and catch-up. Cross-engine HA/promotion is separate from engine-native replication and needs its own RPO/RTO and fencing decisions.
7. **Keep data semantics in provider-neutral ports.** Adapters may use engine-specific transactions and query primitives internally, but the application contracts, actor authorization, idempotency, outbox behavior and domain-shaped results must remain equivalent.

## Current implementation state

- SQLite: registered runtime provider and default for fresh/local installs; provider-matched explicit migrations and stale-schema refusal are implemented in this step.
- PostgreSQL: existing adapter and versioned migrations remain available.
- MongoDB: not implemented; provider selection fails closed.
- Migration journal foundation: durable session/change/checkpoint/apply-ledger schema and SQLite/PostgreSQL storage primitives are implemented. Recording remains opt-in and manual; no existing domain write path is wired to append changes yet, so this is not end-to-end change capture.\n- Online cross-provider replication/hot cutover: not implemented. Consistent snapshot coordination, capture across every mutation path, target entity replay, reconciliation and authoritative writer fencing remain required. Changing `DATABASE_PROVIDER` is not a data migration.
- GraphQL: removal is the accepted target; the runtime remains transitional only until the Web caller migration is completed separately.

## Acceptance gates for online switching

- Every provider passes the same behavior contracts, including concurrent identity/session changes, message/outbox atomicity, idempotency and delete cascades.
- Snapshots and incremental changes are repeatable and ordered; replay can resume from a durable checkpoint.
- Reconciliation proves the target has caught up to a source watermark and documents any intentionally unsupported data.
- A writer fence prevents two providers from accepting authoritative writes concurrently.
- The cutover and rollback runbooks are rehearsed on disposable datasets before any production connection, migration or traffic change.
- Tests cover source failure during copy, target apply failure, duplicate/out-of-order changes, delete tombstones, lag above threshold and failed cutover.

## Consequences

SQLite now gives new/local installations a self-contained default. PostgreSQL stays available for server deployments. The implementation deliberately makes unavailable MongoDB and stale schemas fail loudly. Real-time switching remains future infrastructure work and must not be presented as available until the acceptance gates above pass.
