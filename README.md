# BOT THK — New Product Implementation

This repository is the independent implementation of BOT THK's Web and API product. The previous project is a **functional and behavioral reference**, not an implementation that must be preserved or copied.

## Product and engineering direction

- Reimplement the intended user-facing capabilities with a modern, maintainable architecture. Do not carry forward legacy implementation patterns merely for compatibility.
- Preserve confirmed product capabilities and workflows unless a product behavior is explicitly approved to change.
- When a proposed improvement would change permissions, product behavior, lifecycle rules, data compatibility, or user-visible workflows, document the options, risks, and recommendation and obtain approval before implementing that decision.
- SQLite is the default provider for fresh/local installs. PostgreSQL remains supported, and MongoDB is a future adapter; online cross-provider migration is a separate protocol, not an environment-variable-only switch. Existing production data is not automatically connected to or migrated into the new app.
- Design is a first-class workstream. The current Web UI remains a functional portability/content spike and is not the final visual design.
- **Rich-text editor technology selected:** Lexical will power both article authoring and comment composition, with different feature configurations. Versioned article/comment content contracts and strict backend JSON adapters exist. The Web includes a Lexical writing desk, server-side token proxy, normalized S3-compatible image uploads and a limited rich-comment editor. Media upload is disabled until the S3-compatible storage environment is configured.

## Current implementation status

- `apps/api` exposes a standalone versioned REST API under `/api/v1`, with SQLite-first persistence and PostgreSQL support, self-hosted registration/login/refresh/logout, article CRUD, author profiles, tags, categories, likes/comments, follows, conversations, message history, a notification inbox and an outbox worker. REST is the sole business HTTP transport; the GraphQL runtime and `/graphql` endpoint have been removed.
- The API has PostgreSQL integration tests for persistence, authorization, retries, taxonomy and article workflows.
- Business write routes use shared SQLite/PostgreSQL-backed rate limits by endpoint, verified user, and socket peer IP; `429` responses include `Retry-After`. Proxy deployments must apply throttling at the trusted edge and must not trust client-supplied `X-Forwarded-For`.
- `apps/web` provides localized home, article archive/detail and author pages. Its public-content client uses versioned REST routes under `/api/v1`. Configure `API_BASE_URL` for a direct API origin or use the Vercel-injected `API_SERVICE_URL` binding. The old `API_GRAPHQL_URL` value is accepted for one transition release only and emits a deprecation warning; replace it with `API_BASE_URL`. When no API URL is configured, the local fixture registry remains available for isolated design/build work. If a configured API request fails, the Web app surfaces the failure rather than silently replacing live content with fixtures. The Web writing desk at `/write` uses same-origin server routes to keep access/refresh tokens in HttpOnly cookies, refresh access tokens when needed, and call authenticated article REST routes. Email verification and account recovery remain pending. Image upload requires the server-only `MEDIA_S3_*` configuration described in [Web authoring operations](docs/operations/web-authoring.md).
- Backend identity is an initial lifecycle, not production-ready: email verification, account recovery and other security/operational gates remain open. The article authoring and limited rich-comment flows are integrated with REST. Email verification, account recovery, moderation tools, real-time clients and external push providers remain incomplete. See [the authentication contract](docs/architecture/api-authentication.md).
- `apps/web-rr` is the isolated React Router 7 Framework Mode prototype from Phase 1 of the Web migration. It reuses the shared React components and content helpers from `apps/web`, serves public article/list pages with server-rendered metadata and hard 404s, keeps a private route `no-store`, and starts with `node server.ts` on plain Node.js. It is **not** a production application and replaces no route: `apps/web` remains authoritative. See [the Phase 1 report](docs/roadmap/react-router-prototype.md) and [the next-step decision](docs/roadmap/next-step-decision.md).
- No production deployment, historical data migration, traffic cutover or modification of the old project's repository is performed as part of this branch.

See [phase gates](docs/roadmap/phase-gates.md), [feature traceability](docs/audit/feature-traceability.md), [the behavior baseline](docs/requirements/behavior-baseline.md), and [Persistence-provider and online data-migration plan](docs/architecture/postgres-migration-plan.md). The approved Web framework and hosting-portability work is tracked in [the frontend portability migration roadmap](docs/roadmap/frontend-portability-migration.md) and [ADR 0012](docs/architecture/decisions/0012-portable-web-framework-migration.md).

## Prerequisites

- Node.js 24 (Node.js 24.15.0 or newer is recommended when using SQLite)
- Corepack-enabled pnpm 10
- Docker (optional, for the PostgreSQL profile: `pnpm db:up`)

## Persistence runtime and deployment guidance

The built-in `node:sqlite` API is **not yet stable**: official Node.js v24 documentation classifies it as Stability 1.2 — Release Candidate beginning with Node.js 24.15.0, and earlier Node 24 minors remain experimental. Startup emits a JSON compatibility notice with the selected provider, Node version, API stability classification and deployment recommendation.

SQLite remains the default for local development and single-host installs. **For production/server deployments, PostgreSQL is the recommended provider** while `node:sqlite` remains a release-candidate API. SQLite WAL is not cross-host replication or high availability. See [Persistence provider deployment guidance](docs/deployment/persistence-provider-guidance.md) and [ADR 0010](docs/architecture/decisions/0010-sqlite-first-and-online-provider-cutover.md) for operating boundaries, runtime-upgrade regression requirements, and conditions for revisiting the driver choice. For the Neon production branch, PostgreSQL URLs, private media storage, and service provisioning, see [Neon deployment and operations](docs/operations/neon-deployment.md).

## Observability

The API emits allowlisted JSON request logs with a generated `X-Request-Id`, trace-correlation metadata, bounded route labels, status and elapsed time. `GET /metrics` exposes Prometheus request, duration, authentication-failure and persistence-port metrics after you set `API_METRICS_ENABLED=true` (disabled by default). The separate notification worker can expose outbox backlog and delivery metrics when `OUTBOX_METRICS_PORT` is set; its listener binds to `127.0.0.1` by default. Restrict both metrics endpoints to a trusted monitoring network. See [API observability operations guide](docs/operations/api-observability.md) for names, labels, configuration and limits.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm setup:local      # writes .env.local with a generated development JWT secret
pnpm db:migrate       # create the SQLite schema (explicit step, never automatic)
pnpm dev              # API on :4000 and Web dev server on :3000, plus readiness gates
pnpm check:local      # prove database -> API -> Web -> browser proxy connectivity
```

`pnpm dev` starts both processes from one configuration file and stops both with
one Ctrl+C. `pnpm dev --api-only` / `--web-only` start one of them, and
`pnpm dev --check` runs the connectivity probe as soon as both are ready.

PostgreSQL instead of SQLite (Docker required):

```sh
pnpm db:up                  # postgres:17-alpine + bot_thk_dev + bot_thk_test
pnpm setup:local --force --postgres
pnpm db:migrate && pnpm dev
```

`compose.yaml` contains only the database: the API and Web app run as native Node
processes so hot reload, stack traces and debugging behave normally. The root
`.env.local` is read by both the API (`node --env-file-if-exists`) and the Web app
(`apps/web/next.config.ts`), and a shell export always takes precedence.

See [Local development and local verification](docs/development/local-development.md)
for the environment contract, the full command reference, the probe's assertions
and a troubleshooting table.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm test:routes
pnpm test:prototype   # React Router migration prototype: build + behavior tests
```

## PostgreSQL integration tests

The root `pnpm test` command can run without a database; PostgreSQL cases are deliberately skipped when `TEST_DATABASE_URL` is unset, and their skipped count appears in the test summary. That run alone is **not** evidence that the PostgreSQL adapter passes.

For full local PostgreSQL coverage, start the disposable stack and point the tests at its test database:

```sh
pnpm db:up
# add to .env.local (compose creates bot_thk_test for this purpose)
#   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test
pnpm test                                              # full list, PostgreSQL cases enabled
pnpm --filter @bot-thk/api test:integration            # integration suites only
pnpm db:down                                           # stop, keeping the volume
```

Both commands read `.env.local`, so `TEST_DATABASE_URL` can also be exported in the
shell (PowerShell: `$env:TEST_DATABASE_URL = "..."`). Without it the PostgreSQL
suites skip themselves and report their skipped count.

CI runs the database-independent verification, the PostgreSQL integration suite
and the local-chain job separately (the latter boots both providers through the
scripts above). The `CI / required-checks` aggregate fails unless every job
succeeds, including when a job is skipped or cancelled. Configure
`CI / required-checks` as a required status check for `main` in repository branch
protection/rulesets; that setting is managed by GitHub repository settings and is
not configurable from this workflow file.

For a fresh local API, run `pnpm db:migrate` (or `pnpm --filter @bot-thk/api migrate`) before starting it; SQLite defaults to `apps/api/data/no-wave.sqlite` because `DATABASE_PATH` is resolved against the API package directory, and it can be relocated with `DATABASE_PATH`. Existing deployments that only set `DATABASE_URL` remain on PostgreSQL for compatibility. To select PostgreSQL for new deployments, set `DATABASE_PROVIDER=postgres` and `DATABASE_URL`; MongoDB is not yet implemented. Online switching needs a separate change-capture and cutover process—changing `DATABASE_PROVIDER` alone does not migrate data. For local API-backed Web pages, set `API_BASE_URL` to the API origin (for example, `http://127.0.0.1:4000`). In a container, use the API service's reachable network address rather than `127.0.0.1`. Leave both `API_BASE_URL` and `API_SERVICE_URL` unset only when intentionally using the fixture registry. Migrations are explicit release steps; never connect the branch to production or run migrations against production without a separately approved plan and backup.

The Web article editor uses the pinned Lexical 0.52.0 extension packages. See [Web article authoring operations](docs/operations/web-authoring.md) for the editor contract, cookie boundary, and current limitations. Dependencies are pinned by the committed `pnpm-lock.yaml`. Update the lockfile intentionally when manifests change.
