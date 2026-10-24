# New-project persistence and optional data-migration plan

## Scope and product boundary

The current repository is an independent implementation, not a code-preserving refactor. The previous BOT THK project is used to identify product capabilities, user-visible behavior, data concepts, and known defects. Its programming patterns, database schema, resolver structure, and UI layout are not binding design constraints.

PostgreSQL is the only implemented database adapter for the new application's system of record. The application is being separated into GraphQL transport, application services, domain-grouped repository ports and infrastructure adapters so PostgreSQL, MongoDB and SQLite can implement the same behavior without leaking driver specifics. The current work builds and verifies a new domain schema and APIs. It does **not** copy production data, run dual writes, cut over live traffic, or modify the previous project's repository.

Product behavior changes must be reviewed: when an improvement would change user-visible behavior, authorization policy, destructive lifecycle rules, compatibility guarantees, or data semantics, present the options, impact and recommendation and obtain approval before committing the behavior change.

## New-project environments

- **Local development:** use `DATABASE_URL` with a developer-owned PostgreSQL instance, then run `pnpm --filter @bot-thk/api migrate`.
- **Integration tests:** use `TEST_DATABASE_URL` with a disposable database. The suite can create versioned schema and writes uniquely identified fixtures that it cleans up. Never point it at production or user data.
- **CI:** a dedicated PostgreSQL service and throwaway database run the integration tests.
- **Production:** secrets, TLS, backup schedule, retention, monitoring and process supervision remain release decisions. They are not hard-coded into source.

API startup does not silently execute migrations. Schema changes run as an explicit release step.

## Current persistence responsibilities

The new PostgreSQL schema includes conversations/participants/messages, notification inbox and outbox, revoked sessions, article and localized content blocks, user profiles, dynamic taxonomy/tag associations, article likes/comments, and user follows. The GraphQL API applies authentication and resource-level authorization at the persistence boundary for the covered operations.

The database is a new system of record. It is not currently wired to the legacy MongoDB database and no current feature depends on reading or writing both systems.

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

## Multi-provider architecture and disaster recovery

The current API composes resolvers over application services and domain-grouped persistence ports. PostgreSQL is the only implemented adapter at this stage; choosing `DATABASE_PROVIDER=mongodb` or `sqlite` must fail explicitly until those adapters pass the shared adapter contract and behavior suites.

Do not equate multi-provider switching with cross-engine HA. First provide tested adapter parity. For production resilience, prefer high availability within the active engine. If a secondary cross-engine copy is required, start with one write authority and an asynchronous, checkpointed replication pipeline into a read-only warm standby. Requiring the API to write to both databases synchronously is a separate and higher-risk decision because partial commits create divergence.

Before building automated cross-engine promotion, approve RPO/RTO targets, consistency requirements by domain, conflict/deletion rules, promotion authority and fencing/split-brain prevention. See ADR 0005.
