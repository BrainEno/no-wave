# ADR 0005: Clean Architecture and provider-independent persistence

- Status: Accepted; provider priority and live-switch requirements updated by [ADR 0010](0010-sqlite-first-and-online-provider-cutover.md)
- Date: 2026-10-24

## Context

The new project is a greenfield implementation of BOT THK capabilities. The legacy project is used to discover behaviors and data concepts, not to constrain the new technical design. The current PostgreSQL store contains many domain operations in one adapter module; the next architecture step is to establish explicit application-facing ports so transport and use cases do not depend on PostgreSQL-specific APIs.

The desired future providers are PostgreSQL, MongoDB, and SQLite. The same domain behavior should be exercised by a provider contract test suite. Switching providers must be explicit and must fail closed if the selected adapter is unavailable; the app must never silently fall back to another database.

## Decision

Use dependency direction:

`REST transport → application use cases/services → domain repository ports → infrastructure adapter`. GraphQL is removal-only transition code; it must not receive new operations and is not part of the target architecture.

- REST handlers authenticate the request and translate transport inputs/errors; they should not contain SQL, driver queries or provider-specific branching.
- Application services express user-visible use cases and coordinate domain operations.
- Persistence ports are grouped by bounded domain: content, taxonomy, profiles, engagement, conversations, notifications, sessions, outbox and operational health.
- Provider adapters implement the same contracts and return domain-shaped records. Driver-native rows and query types stay inside the adapter.
- Transactions are exposed as domain-level atomic operations (e.g. message + outbox intent); do not expose a raw SQL transaction object to the domain.
- Provider selection is configured through `DATABASE_PROVIDER`; a provider that is not implemented or configured causes startup to fail explicitly.
- Cross-engine replication is a separate infrastructure service. It is not implemented as arbitrary dual writes within repositories.

## Adapter status

- SQLite: registered default runtime provider for fresh/local installs; shared persistence contracts are exercised in CI.
- PostgreSQL: supported adapter and optional provider, retained for deployments that explicitly select it.
- MongoDB: planned adapter; unavailable until all ports, transaction/outbox semantics and provider contract tests pass.
- Live cross-provider migration: architecture target only; change capture, watermark validation, fencing and rollback orchestration are not yet implemented.

## Replication and failover

Do not make two heterogeneous databases independently authoritative for the same data. A transaction that succeeds in one and fails in the other creates split state; there is no ordinary local transaction spanning PostgreSQL and MongoDB. Retry/outbox mechanisms provide at-least-once event delivery, not automatic strong consistency between both stores.

Consider these distinct levels:

1. **Within-engine HA (recommended first):** PostgreSQL primary/standby or managed HA for the primary production datastore, and MongoDB replica-set HA if MongoDB is later selected for a deployment. This is the primary mechanism for low-RPO failover.
2. **Cross-engine warm standby:** one authoritative write source; a transactional change log/outbox or CDC pipeline asynchronously projects changes to the other engine. The secondary is read-only until a reviewed promotion. Define idempotency, ordering, delete/tombstone semantics, schema versioning, checkpoints, lag monitoring, reconciliation and split-brain fencing.
3. **Synchronous dual write / active-active (not recommended as default):** adds tail latency, partial success, conflict resolution and write-ordering problems. It must not be implemented without a separate consistency protocol and explicit acceptance criteria.

SQLite is useful as a local/test/single-node provider, but it is not a drop-in distributed failover node. SQLite WAL requires the participating processes to share a host and is not intended for use across hosts through a network filesystem.

## Product/operations decisions still required before implementing cross-engine failover

- Which database is authoritative for writes.
- Whether the other engine is a backup/warm standby or must serve live reads during primary failure.
- Acceptable Recovery Point Objective (RPO): how much recently committed data, if any, can be lost.
- Acceptable Recovery Time Objective (RTO): how long failover may take.
- Whether promotion is manual or automatic, and what fencing mechanism prevents writes to both primaries.
- Which consistency level is required for posts, likes/comments, follows, messages, notification read state and deletions.
- Whether SQLite is only for local/edge use or should be eligible in any server production environment.

SQLite is the default for fresh installs, with PostgreSQL retained as an adapter. No MongoDB adapter, cross-engine data synchronization, hot provider switch or automatic promotion is implied until the separate acceptance gates in ADR 0010 pass.

## Operational references

- PostgreSQL high availability and replication: https://www.postgresql.org/docs/current/high-availability.html
- PostgreSQL synchronous and asynchronous standby behavior: https://www.postgresql.org/docs/current/warm-standby.html
- MongoDB change streams (replica-set/sharded-cluster prerequisite and resumable event flow): https://www.mongodb.com/docs/manual/changestreams/
- MongoDB write concern and durability/latency trade-offs: https://www.mongodb.com/docs/manual/core/replica-set-write-concern/
- SQLite WAL behavior and same-host constraint: https://www.sqlite.org/wal.html

