# ADR 0010: SQLite-first persistence and online provider cutover

- Status: Accepted
- Date: 2026-10-28
- Supersedes: ADR 0004 for default-provider priority; preserves PostgreSQL as a supported adapter

## Context

The project needs to work locally with minimal infrastructure, while retaining a path to PostgreSQL and MongoDB deployments and the ability to move between providers without treating database selection as a data migration. The codebase already has provider-independent persistence ports, a composed SQLite adapter and a PostgreSQL adapter. MongoDB is not yet implemented. The previous plan made PostgreSQL the only runtime provider and deferred SQLite despite its store/contract test coverage.

The product owner has confirmed that REST is the sole business HTTP API. The Web caller has been migrated, and the GraphQL runtime, schema, endpoint, dependencies and obsolete tests have been removed; no GraphQL transport is part of the target architecture.

## Decisions

1. **SQLite is the default for fresh/local installs.** Use `DATABASE_PATH` (default `./data/no-wave.sqlite`). Local database files, WAL files and SHM files must not be committed. Migrations are explicit by default; startup refuses an uninitialized or stale SQLite schema. `DATABASE_AUTO_MIGRATE=true` is an explicit local/test convenience, not a production release policy.
2. **PostgreSQL remains supported.** Select it with `DATABASE_PROVIDER=postgres` and `DATABASE_URL`. For backwards compatibility, a pre-existing environment that sets `DATABASE_URL` but no `DATABASE_PROVIDER` continues to select PostgreSQL rather than silently switching to a new SQLite database.
3. **MongoDB remains a target adapter, not an available provider yet.** It may be selected only after every persistence port, transaction/outbox guarantee, migration path and shared behavioral contract passes. Unsupported providers fail closed; they never fall back to another engine.
4. **REST is the only business HTTP API.** The GraphQL runtime/schema/endpoint, Yoga packages, configuration and obsolete GraphQL tests have been removed after the Web caller migrated to REST. Do not reintroduce the GraphQL transport or add a parallel business API. Backend-only provider changes do not modify `apps/web/`.
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
- Migration journal foundation: durable session/change/checkpoint/apply-ledger schema and SQLite/PostgreSQL storage primitives are implemented. Opt-in change capture is wired into SQLite and PostgreSQL transactions for article create/update and taxonomy links, taxonomy create/delete, profile upserts, follow/unfollow, article likes/comments, conversation/participant changes, message plus outbox creation, conversation-deletion tombstones, notification create/delivery/read-state changes, identity/session/refresh-token state, rate-limit counters/cleanup, and outbox claim/delivery/retry state. Captured rows are appended in the same source transaction and share a transaction envelope. Capture runs only while a matching source-provider session is in `recording`, `backfilling` or `catching_up`.
- Capture coverage is not exhaustive yet: direct SQL writes or future mutation paths outside the instrumented stores may bypass the journal. Transactional target replayers for SQLite and PostgreSQL are now implemented with an explicit entity/column allowlist, row-key validation, JSON-column normalization, delete tombstones, transaction-envelope atomicity, and an idempotent applied-change ledger/checkpoint. Replay resumes from the durable target checkpoint; a stopped source session can still be drained after capture is fenced. MongoDB replay is not implemented.
- The capture journal includes sensitive identity snapshots while a migration is active, including password hashes and refresh-token hashes (never plaintext passwords or raw refresh-token secrets). Treat the journal as credential-sensitive data: restrict database and log access, minimize retention, and explicitly review the security/retention policy before any production capture session is enabled.
- Online cross-provider replication/hot cutover: not implemented. Consistent initial snapshot and watermark coordination, full write-path audit, reconciliation, authoritative writer fencing, cutover and rollback remain required. Changing `DATABASE_PROVIDER` is not a data migration.
- GraphQL: the runtime, endpoint and Web GraphQL caller have been removed; REST is the sole business HTTP transport.

## Risks and mitigation

- **The built-in SQLite driver is not a stable API.** The official [Node.js v24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) marks `node:sqlite` as Stability 1.2 — Release Candidate starting with Node.js 24.15.0; earlier Node 24 minors still mark it experimental. Release Candidate is not Stability 2 (Stable), so semantic changes remain a compatibility risk even though the API is no longer behind an experimental flag. This repository supports Node `>=24 <25`; Node 24.15.0 is the minimum recommended version for the current RC contract.
- **Do not present SQLite and PostgreSQL as equivalent deployment profiles.** SQLite remains the convenient fresh/local default and is intended for local or single-host deployment. PostgreSQL is recommended for production/server deployments, multiple API instances, and operational requirements beyond one host. WAL is not a cross-host replication or high-availability mechanism. See [persistence-provider deployment guidance](../../deployment/persistence-provider-guidance.md).
- **Make the risk visible at runtime.** The API emits one JSON startup declaration containing the selected provider, Node version, SQLite stability classification and deployment recommendation. This notice is diagnostic information, not a substitute for testing or a runtime compatibility guarantee.
- **Pin behavior assumptions with tests.** The SQLite regression suite characterizes the actual Node 24 binding contract: ordinary JavaScript numbers bind with SQLite REAL semantics, bigint can represent SQLite INTEGER, and booleans currently bind as SQLite integer `0/1`. Every Node runtime upgrade must pass this test plus the full test, typecheck, build and route verification workflow; a change is an explicit compatibility review rather than an unnoticed assumption.
- **Re-evaluate the driver before production reliance and Node upgrades.** If binding semantics regress, the upstream API changes incompatibly, stabilization is delayed beyond the project's accepted risk tolerance, or deployment demands exceed SQLite's single-host profile, review switching the deployment to PostgreSQL or evaluating a maintained SQLite driver such as `better-sqlite3`. Any new driver requires a maintenance, security, license and native-build portability review plus the full persistence adapter contract tests. A driver replacement or provider setting change must never be treated as an automatic data migration.

## Acceptance gates for online switching

- Every provider passes the same behavior contracts, including concurrent identity/session changes, message/outbox atomicity, idempotency and delete cascades.
- Snapshots and incremental changes are repeatable and ordered; replay can resume from a durable checkpoint.
- Reconciliation proves the target has caught up to a source watermark and documents any intentionally unsupported data.
- A writer fence prevents two providers from accepting authoritative writes concurrently.
- The cutover and rollback runbooks are rehearsed on disposable datasets before any production connection, migration or traffic change.
- Tests cover source failure during copy, target apply failure, duplicate/out-of-order changes, delete tombstones, lag above threshold and failed cutover.

## Consequences

SQLite now gives new/local installations a self-contained default. PostgreSQL stays available for server deployments. The implementation deliberately makes unavailable MongoDB and stale schemas fail loudly. Real-time switching remains future infrastructure work and must not be presented as available until the acceptance gates above pass.
