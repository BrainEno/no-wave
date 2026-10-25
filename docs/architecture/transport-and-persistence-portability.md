# Transport and Persistence Portability

## Architectural requirement

Business behavior must not depend on either the wire protocol or the database engine. REST and GraphQL are adapters over the same application use cases; SQLite and PostgreSQL are adapters behind the same persistence contracts. A deployment provider is not an architectural boundary.

```text
REST routes ─────┐
                 ├─> application use cases ─> domain rules
GraphQL resolvers┘              │
                                v
                      repository / unit-of-work ports
                         │                  │
                    SQLite adapter    PostgreSQL adapter
```

## Required dependency direction

- Transport modules may validate and normalize transport input, call application use cases, and serialize transport output.
- Transport modules must not contain domain rules, direct SQL, driver-specific row mapping, or independent authorization policy.
- Application use cases own workflow orchestration, authorization decisions, and transaction boundaries. They depend on domain contracts and persistence ports, never on GraphQL, HTTP request/response objects, or database drivers.
- Persistence adapters implement the same behavioral contract. Driver-specific SQL, row mapping, locking, migrations, and transaction mechanics stay inside the adapter.
- Runtime composition selects transports and persistence adapters explicitly. An unavailable provider must fail at startup; never silently fall back to another database.

## REST and GraphQL compatibility

Both transports must call the same application use cases. GraphQL resolver functions are not the business API and REST handlers must not call GraphQL over HTTP. Introduce REST resources incrementally and map them to shared use cases, including the same authentication, authorization, validation, idempotency, and error semantics.

The REST API must have an explicit version prefix (for example `/api/v1`), stable JSON error envelopes, documented pagination, and route-level contract tests. GraphQL remains an optional transport: disabling it must not disable the application layer or REST routes. Likewise, a deployment that supports GraphQL can enable that transport without changing persistence.

## SQLite and PostgreSQL portability

A common method-name interface is necessary but insufficient. The shared adapter contract must specify behavioral semantics for:

- Atomic multi-record operations and rollback on failure.
- Unique constraints, case/Unicode normalization, foreign keys, and deletion behavior.
- Cursor ordering and pagination stability.
- Idempotency keys and concurrent duplicate requests.
- Session revocation visibility across requests.
- Transactional outbox claiming, retry, and delivery state.
- Date/time precision and JSON/content serialization.
- Health checks, migrations, backup/restore, and graceful close.

SQLite is a good default for a single-instance, low-operations-cost deployment and local-first use. Use a persistent disk, enable foreign keys, select and test a journal/busy-timeout policy, and serialize write transactions where needed. Do not put the SQLite database on an arbitrary network filesystem. SQLite does not automatically provide safe multi-instance shared writes; horizontal scaling and multi-host writers require a deliberate database/consistency decision.

PostgreSQL remains useful for higher concurrent-write workloads, multiple API instances, and managed database hosting. The choice must be explicit configuration, not hidden behavior.

## Migration and data portability

Switching a driver is not the same as moving existing data. Before production migration, provide:

1. Versioned migrations for each supported engine.
2. Adapter contract tests running against every engine.
3. A tested export/import tool with stable IDs, locale and timestamp handling.
4. Row-count and content-hash reconciliation, plus foreign-key/invariant checks.
5. Backup and restore rehearsal, a rollback plan, and a write-freeze or change-capture strategy.

Never automatically switch a live deployment from one database to another on connection failure. This can create divergent sources of truth or data loss.

## Incremental implementation plan

1. Keep GraphQL as the first transport while extracting schema/resolvers from HTTP lifecycle code.
2. Introduce the first REST vertical slice using the existing application services (health and public article listing/detail); add route tests proving REST and GraphQL return equivalent domain results.
3. Move transport-specific serialization and error mapping to separate adapters, keeping auth and business workflows in shared use cases.
4. Implement SQLite behind the existing persistence contract; run the same adapter contract suite against SQLite and PostgreSQL, and document any engine-specific capabilities.
5. Expand REST resource coverage and add export/import and deployment smoke tests before declaring either transport or engine interchangeable.

## Current verified state

- The repository has an application-services facade and domain-grouped persistence ports.
- PostgreSQL is the only built-in persistence runtime provider.
- GraphQL is the only implemented API transport in the current server.
- SQLite adapter, REST resource routes, cross-transport contract tests, and cross-engine migration tooling are not yet implemented.

Do not describe REST/GraphQL or SQLite/PostgreSQL as interchangeable until the corresponding shared contract and integration tests pass.
