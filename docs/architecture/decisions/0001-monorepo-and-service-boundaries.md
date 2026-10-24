# ADR 0001: Monorepo and Service Boundaries

- Status: Accepted as the initial direction
- Date: 2026-10-22

## Context

BOT THK needs a public SEO-friendly blog, authenticated social features, private messaging and notifications, with potential React Native and Tauri clients. The existing frontend and TypeScript GraphQL backend are separate projects. Portability beyond a single deployment vendor is an explicit requirement.

## Decision

Use a workspace monorepo with independently deployable applications. Begin with a modular monolith API, not microservices.

Proposed structure (subject to the web-framework spike):

```text
apps/
  web/          # framework TBD; SSR/SSG and web experience
  api/          # independent GraphQL/API service
  worker/       # optional later, if durable async work requires it
  mobile/       # future React Native client
  desktop/      # future Tauri client
packages/
  contracts/    # GraphQL schema/operations and generated types
  validation/   # genuinely shared platform-neutral validation
  api-client/   # add if shared typed client helpers prove useful
  ui/           # optional web UI; not forced across native clients
  config/       # shared lint/format/TypeScript configuration
docs/
  requirements/
  testing/
  architecture/decisions/
  agentic-coding/
```

Use pnpm workspaces and one lockfile. Add Turborepo or equivalent orchestration when task caching and dependency graph benefits are clear.

The API owns domain rules, authorization, identity, message/notification persistence and data access. Shared packages may expose API contracts, generated operation types, shared validation and platform-neutral utilities. Database models, JWT internals, server secrets and server-only services remain inside the API.

## Consequences

- Web, mobile and desktop can use the same backend and API contracts.
- Applications can be deployed independently.
- The repository can centralize CI, tooling and documentation.
- Package boundaries and client/server import safety must be enforced.
- One repository does not mean one runtime or one deployment.

## Rejected defaults

- Putting all backend business logic in Next.js handlers: rejected as the default because non-web clients should not depend on a web-framework runtime boundary.
- Splitting domains into microservices immediately: rejected until scaling or operational evidence justifies the added complexity.
- Sharing all UI across web and native: rejected because DOM and native UI components differ.
