# ADR 0003: GraphQL API runtime

- Status: Superseded by ADR 0006 on 2026-10-27; GraphQL is retained only during staged migration.
- Date: 2026-10-23

## Status note

This ADR records the initial GraphQL runtime decision. The product owner has since approved a REST-only business HTTP API; follow ADR 0006 for the target architecture and remove this runtime after REST parity is verified.

## Context

The legacy product already uses GraphQL and its web client consumes GraphQL subscriptions over SSE. The API must be independent from Next.js so future React Native and Tauri clients can use the same domain contracts. The current Apollo Server 3 backend is outdated, and its real-time delivery implementation is not durable.

## Decision

Use **GraphQL Yoga v5** in a standalone Node.js 24 HTTP process for the initial API spike.

Reasons:
- Yoga provides a GraphQL-over-HTTP server with an environment-agnostic Fetch API core, fitting the portability requirement.
- Its documented subscription support uses Server-Sent Events; the optional @graphql-yoga/plugin-graphql-sse supports a dedicated /graphql/stream endpoint compatible with the legacy transport shape.
- Existing clients can continue evaluating graphql-sse / urql compatibility without tying domain logic to Next.js.
- Start as a modular monolith API. Do not introduce microservices or a separate worker until durable asynchronous delivery needs and operational boundaries are implemented.

## Security and delivery constraints

- Construct request context only after validating the server-side session/token; never trust client-supplied sender IDs or user IDs as identity.
- Apply authorization at each resolver/service boundary and test denied operations for absence of side effects.
- Keep persistence authoritative for messages and notifications. SSE is a live transport, not a durable inbox or delivery guarantee.
- In-memory PubSub is for local development/tests only. Before multi-instance production use, select and test a shared event distribution mechanism.
- Do not expose production credentials or connect the spike to production data.

## Initial scope

The first API slice will expose health/readiness and a minimal GraphQL schema, verify unauthenticated behavior, and exercise an authenticated-context boundary with test fixtures. It will not implement production login, refresh tokens, database persistence or real message delivery.

## Revisit when

Revisit this ADR if client compatibility tests fail, the deployment target requires a different adapter, or operational measurements justify another runtime.
