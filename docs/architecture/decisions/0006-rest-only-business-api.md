# ADR 0006: REST-only business API

- Status: Accepted
- Date: 2026-10-27
- Supersedes: ADR 0003 (GraphQL API runtime)

## Context

The application already has a standalone API, application-service composition, domain-grouped persistence ports, PostgreSQL persistence, and initial versioned REST read endpoints. The Web public-content client still uses GraphQL, while the REST layer and GraphQL layer expose overlapping but non-identical contracts. Maintaining both transports adds API, test, security-review, and operational surface without a demonstrated requirement that cannot be met by REST.

The product requires published content, author profiles, categories and tags, authenticated writing and editing, follows, likes/comments, private conversations, durable notification history, background notification processing, and eventually real-time updates. None of those capabilities intrinsically requires GraphQL.

## Decision

1. **REST is the only business HTTP API, and GraphQL is to be completely removed.** Use explicit, versioned JSON routes under `/api/v1`. Do not add GraphQL operations or extend the transitional runtime. Keep the runtime only until existing Web callers have moved in a separate Web-focused change, then remove its endpoint, schema, Yoga runtime, packages and obsolete tests.
2. **Migrate in stages.** Keep GraphQL temporarily while Web and all existing callers are migrated and REST equivalents are covered by tests. Only then remove the GraphQL schema, Yoga runtime, dependency, endpoint configuration and GraphQL-specific tests.
3. **Preserve domain boundaries.** REST handlers validate and serialize transport input/output, then call application services. Business rules, authorization, transactions, idempotency, persistence and outbox behavior remain in their existing domain/application/infrastructure layers.
4. **Use stable author identity.** Public author routes and article filtering use `userId`, not a display name or a field misleadingly called `username`. Author filtering must occur in persistence before sorting/pagination.
5. **Validate public API locales explicitly.** Public REST content routes support `zh-CN`, `zh-TW`, and `en`, matching the website's supported locales and persisted translations. Any other locale fails validation instead of silently falling back.
6. **Keep real-time transport separate from business HTTP.** Start with ordinary REST requests and durable persistence. Use SSE for server-to-client events when sufficient; introduce WebSocket only where a concrete bidirectional use case warrants it. Real-time events are hints/delivery, not authoritative message or notification state.
7. **Keep background work independent.** Scheduled work, outbox delivery, retries and notification materialization run in supervised workers/schedulers; they are not implemented as long-running HTTP requests and do not depend on GraphQL subscriptions.
8. **Security remains transport-independent.** Every private operation derives the actor from verified server-side identity; resource ownership is enforced server-side. Apply bounded input/pagination, payload-size limits, rate limits, sanitized errors, idempotency where retries are possible, and explicit authorization regression tests. REST is not considered secure merely because it replaces GraphQL.

## Migration sequence

- Add stable-ID REST reads for public content and author resources.
- Switch Web public content, author pages, discovery pages and sitemap to REST with contract tests.
- Migrate article writes, profile changes, follows, engagement, conversation lifecycle, message history/send/read state, and notification queries/updates.
- Define and test SSE/WebSocket reconnect behavior only when each client flow needs it; verify outbox retries, idempotency, offline recovery and authorization.
- No GraphQL features are in scope. The Web public-content caller has been migrated to REST, and the backend GraphQL schema, Yoga runtime, `/graphql` endpoint, direct dependencies, and GraphQL-specific transport tests are removed in the REST-only cleanup following PR #69.

## Implementation status — 2026-10-28

The staged migration and final removal gate have been completed in the Web REST migration and backend cleanup commits on PR #69. The Web client issues GET requests only to versioned REST routes. The server returns JSON 404 responses for unknown/legacy routes. CI validates unit tests, typechecking, production build, route smoke tests and PostgreSQL integration tests through the required aggregate check. The legacy `API_GRAPHQL_URL` environment variable remains only as a one-release configuration alias: the client strips its terminal `/graphql` path, warns operators to migrate to `API_BASE_URL`, and never sends a GraphQL request.

## Deployment and acceptance

The API must remain independently deployable from the Next.js Web service. Validate the same REST contract in the container and on the selected hosting runtime. Persistent workers and long-lived real-time connections require explicit runtime compatibility checks; do not assume serverless HTTP functions provide durable scheduling or connection lifetime.

Acceptance for final removal: no production or test caller imports or invokes GraphQL; every previously supported operation has a documented REST contract and equivalent authorization/persistence tests; the complete CI gate passes; and no production migration or cutover is implied by the code change.
