# BOT THK — New Product Implementation

This repository is the independent implementation of BOT THK's Web and API product. The previous project is a **functional and behavioral reference**, not an implementation that must be preserved or copied.

## Product and engineering direction

- Reimplement the intended user-facing capabilities with a modern, maintainable architecture. Do not carry forward legacy implementation patterns merely for compatibility.
- Preserve confirmed product capabilities and workflows unless a product behavior is explicitly approved to change.
- When a proposed improvement would change permissions, product behavior, lifecycle rules, data compatibility, or user-visible workflows, document the options, risks, and recommendation and obtain approval before implementing that decision.
- The new application has its own PostgreSQL schema. Existing production data is not automatically connected to or migrated into it.
- Design is a first-class workstream. The current Web UI remains a functional portability/content spike and is not the final visual design.
- **Rich-text editor technology selected:** Lexical will power both article authoring and comment composition, with different feature configurations. The decision and content-contract requirements are recorded in [ADR 0007](docs/architecture/decisions/0007-lexical-rich-text-editors.md); editor UI, serialization adapters and media upload remain pending.

## Current implementation status

- `apps/api` has a standalone GraphQL server, PostgreSQL persistence/migrations, authenticated article CRUD, author profiles, user-generated Unicode hashtags, categories, likes/comments, follow graph, conversation lifecycle, message history, notification inbox and an outbox worker.
- The API has PostgreSQL integration tests for persistence, authorization, retries, taxonomy and article workflows.
- `apps/web` provides localized home, article archive/detail and author pages. Set `API_GRAPHQL_URL` to use the standalone GraphQL API for public content; when it is unset, the local fixture registry remains available for isolated design/build work. If the API URL is configured but requests fail, the Web app surfaces the failure rather than silently replacing live content with fixtures. The sign-in page is intentionally a placeholder.
- JWT issuance/real account authentication, API-to-Web integration, full editor UX, Lexical integration, media upload, real-time client integration, external push providers and production operations remain incomplete.
- No production deployment, historical data migration, traffic cutover or modification of the old project's repository is performed as part of this branch.

See [phase gates](docs/roadmap/phase-gates.md), [feature traceability](docs/audit/feature-traceability.md), [the behavior baseline](docs/requirements/behavior-baseline.md), and [PostgreSQL and data migration plan](docs/architecture/postgres-migration-plan.md).

## Prerequisites

- Node.js 24
- Corepack-enabled pnpm 10

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

Use a developer-owned database for local work and a disposable database for tests. For API-backed Web pages, configure `API_GRAPHQL_URL` in the Web server environment (for example, `http://127.0.0.1:4000/graphql` when both processes run on the same host). In a container, use the API service's reachable network address rather than `127.0.0.1`. Leave the variable unset only when intentionally using the fixture registry. Migrations are explicit release steps; never connect the branch to production or run migrations against production without a separately approved plan and backup.

Dependencies are pinned by the committed `pnpm-lock.yaml`. Update the lockfile intentionally when manifests change.
