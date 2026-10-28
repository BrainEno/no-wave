# BOT THK — New Product Implementation

This repository is the independent implementation of BOT THK's Web and API product. The previous project is a **functional and behavioral reference**, not an implementation that must be preserved or copied.

## Product and engineering direction

- Reimplement the intended user-facing capabilities with a modern, maintainable architecture. Do not carry forward legacy implementation patterns merely for compatibility.
- Preserve confirmed product capabilities and workflows unless a product behavior is explicitly approved to change.
- When a proposed improvement would change permissions, product behavior, lifecycle rules, data compatibility, or user-visible workflows, document the options, risks, and recommendation and obtain approval before implementing that decision.
- SQLite is the default provider for fresh/local installs. PostgreSQL remains supported, and MongoDB is a future adapter; online cross-provider migration is a separate protocol, not an environment-variable-only switch. Existing production data is not automatically connected to or migrated into the new app.
- Design is a first-class workstream. The current Web UI remains a functional portability/content spike and is not the final visual design.
- **Rich-text editor technology selected:** Lexical will power both article authoring and comment composition, with different feature configurations. Versioned article/comment content contracts and strict backend JSON adapters exist; the Web editor UI and approved media-upload workflow remain pending.

## Current implementation status

- `apps/api` exposes a standalone versioned REST API under `/api/v1`, with SQLite-first persistence and PostgreSQL support, self-hosted registration/login/refresh/logout, article CRUD, author profiles, tags, categories, likes/comments, follows, conversations, message history, a notification inbox and an outbox worker. REST is the sole business HTTP transport; the GraphQL runtime and `/graphql` endpoint have been removed.
- The API has PostgreSQL integration tests for persistence, authorization, retries, taxonomy and article workflows.
- `apps/web` provides localized home, article archive/detail and author pages. Its public-content client uses versioned REST routes under `/api/v1`. Configure `API_BASE_URL` for a direct API origin or use the Vercel-injected `API_SERVICE_URL` binding. The old `API_GRAPHQL_URL` value is accepted for one transition release only and emits a deprecation warning; replace it with `API_BASE_URL`. When no API URL is configured, the local fixture registry remains available for isolated design/build work. If a configured API request fails, the Web app surfaces the failure rather than silently replacing live content with fixtures. The sign-in page is intentionally a placeholder.
- Backend identity is an initial lifecycle, not production-ready: email verification, recovery, browser token storage and other security/operational gates remain open. API-to-Web integration, editor UX, media upload, real-time clients and external push providers are also incomplete. See [the authentication contract](docs/architecture/api-authentication.md).
- No production deployment, historical data migration, traffic cutover or modification of the old project's repository is performed as part of this branch.

See [phase gates](docs/roadmap/phase-gates.md), [feature traceability](docs/audit/feature-traceability.md), [the behavior baseline](docs/requirements/behavior-baseline.md), and [Persistence-provider and online data-migration plan](docs/architecture/postgres-migration-plan.md).

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

## PostgreSQL integration tests

The root `pnpm test` command can run without a database; PostgreSQL cases are deliberately skipped when `TEST_DATABASE_URL` is unset, and their skipped count appears in the test summary. That run alone is **not** evidence that the PostgreSQL adapter passes.

For full local PostgreSQL coverage, start a disposable PostgreSQL 17 instance:

```sh
docker run -d --rm --name no-wave-test-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=bot_thk_test \
  -p 5432:5432 postgres:17-alpine
until docker exec no-wave-test-postgres pg_isready -U postgres -d bot_thk_test; do sleep 1; done
```

In PowerShell, first set `$env:TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/bot_thk_test"` and then run `pnpm --filter @bot-thk/api test:integration`. In Bash-compatible shells, run `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/bot_thk_test pnpm --filter @bot-thk/api test:integration`. To run the entire root test list with PostgreSQL cases enabled, run `pnpm test` in that same environment. Stop the disposable server afterward with `docker stop no-wave-test-postgres`.

CI runs the database-independent verification and PostgreSQL integration suite separately. The `CI / required-checks` aggregate fails unless both jobs succeed, including when a job is skipped or cancelled. Configure `CI / required-checks` as a required status check for `main` in repository branch protection/rulesets; that setting is managed by GitHub repository settings and is not configurable from this workflow file.

For a fresh local API, run `pnpm --filter @bot-thk/api migrate` before `pnpm --filter @bot-thk/api start`; SQLite defaults to `./data/no-wave.sqlite` and can be relocated with `DATABASE_PATH`. Existing deployments that only set `DATABASE_URL` remain on PostgreSQL for compatibility. To select PostgreSQL for new deployments, set `DATABASE_PROVIDER=postgres` and `DATABASE_URL`; MongoDB is not yet implemented. Online switching needs a separate change-capture and cutover process—changing `DATABASE_PROVIDER` alone does not migrate data. For local API-backed Web pages, set `API_BASE_URL` to the API origin (for example, `http://127.0.0.1:4000`). In a container, use the API service's reachable network address rather than `127.0.0.1`. Leave both `API_BASE_URL` and `API_SERVICE_URL` unset only when intentionally using the fixture registry. Migrations are explicit release steps; never connect the branch to production or run migrations against production without a separately approved plan and backup.

Dependencies are pinned by the committed `pnpm-lock.yaml`. Update the lockfile intentionally when manifests change.
