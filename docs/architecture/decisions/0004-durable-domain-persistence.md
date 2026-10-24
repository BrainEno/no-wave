# ADR 0004: PostgreSQL as the new product's system of record

- Status: Accepted for the new implementation; production rollout and any historical-data import remain gated
- Date: 2026-10-24

## Decision

Use PostgreSQL as the durable persistence layer for the new BOT THK implementation. Use the `postgres` JavaScript client and versioned SQL migrations while domain contracts are still evolving; introduce an ORM only if a demonstrated maintenance need justifies it.

The previous project is a feature/behavior reference. The new application is not required to preserve the old MongoDB schema, resolver implementation, or other legacy technical choices.

## Context

The product needs durable content and localized article blocks, user profiles, user-generated tags, article engagement, follows, conversations, messages, unread state, notification inbox and retryable event delivery. Authorization must be enforced by server-side identity and authoritative resource membership/ownership.

A relational system with transaction support, uniqueness constraints and a transactional outbox fits these requirements. PostgreSQL also supports local development, containers and managed providers without a source-code dependency on one deployment vendor.

## Consequences

- The new application owns a separate schema and must not read/write both databases by accident.
- Existing production data is not automatically imported; whether to start clean or import a snapshot is a separate product/release decision.
- Versioned SQL migrations are reviewable and run as explicit release steps, not silently on API startup.
- Authentication and authorization contracts belong to the new application. Accepting legacy tokens is not automatic; any issuer integration or token exchange requires a reviewed trust contract.
- The new system can improve unsafe legacy behavior, but changes to product rules, permissions or destructive actions require user approval first.

## Acceptance criteria

- Message and outbox intent commit atomically.
- Reusing an idempotency key with a different payload fails explicitly.
- Notification delivery retries do not create duplicate logical inbox entries.
- Conversation membership and article ownership are checked in trusted server-side persistence operations.
- Session revocation is durable.
- Dynamic tags are stored as data, not a hard-coded enumeration; repeated creation of the same normalized hashtag is idempotent.
- Migration execution is repeatable and serialized with a PostgreSQL advisory lock.
- CI exercises transactions, idempotency, ownership, dynamic tags and session revocation against disposable PostgreSQL.

See [New-project persistence and optional data-migration plan](../postgres-migration-plan.md).

## Provider independence and replication boundary

ADR 0005 defines the Clean Architecture boundary between GraphQL transport, application services, repository ports and provider adapters. The current PostgreSQL store is the first adapter and is not yet interchangeable with MongoDB or SQLite; those implementations must pass the same behavior contract before provider switching is advertised.

Cross-engine replication/failover is not equivalent to configuring database replicas. PostgreSQL replication and MongoDB replica sets offer engine-native HA; copying changes between PostgreSQL and MongoDB is a separate asynchronous projection/CDC problem unless a formally reviewed distributed consistency protocol is adopted.
