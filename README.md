# BOT THK — New Product Implementation

> **Language / 语言:** **English** · [简体中文](./README.zh-CN.md)
>
> New here? Jump to [Quick start](#quick-start) or the full [Local development](#local-development) guide.

This repository is the independent implementation of BOT THK's Web and API product. The old project is a functional and behavioral reference, not code that has to be preserved or copied.

## Contents

- [Quick start](#quick-start)
- [Product and engineering direction](#product-and-engineering-direction)
- [Current implementation status](#current-implementation-status)
- [Prerequisites](#prerequisites)
- [Persistence runtime and deployment guidance](#persistence-runtime-and-deployment-guidance)
- [Observability](#observability)
- [Local development](#local-development)
- [Other checks and commands](#other-checks-and-commands)
- [PostgreSQL integration tests](#postgresql-integration-tests)
- [Database and URL configuration reference](#database-and-url-configuration-reference)
- [CI](#ci)
- [Lexical note](#lexical-note)

## Quick start

For everyday development, use a **local database**. This path needs no Docker and does **not** consume Neon quota.

```sh
corepack enable                    # once, if pnpm is not on your PATH
pnpm install --frozen-lockfile
pnpm setup:local                   # writes .env.local: SQLite + a generated JWT secret
pnpm db:migrate                    # creates apps/api/data/no-wave.sqlite
pnpm dev                           # API :4000 + Web :3000
```

In a second terminal, verify the whole chain:

```sh
pnpm check:local
```

To verify that a work published from the writing desk is actually visible — with
no SMTP service and no `.env.local` — run:

```sh
pnpm verify:publish
```

It starts a disposable stack, creates the author profile that public pages
require, publishes through the Web writing-desk proxy, reads the article
anonymously, and prints the article and archive links. Use
`pnpm verify:publish --keep` to leave the stack running, or `--api-url` /
`--web-url` to check an existing chain. See
[Publishing visibility without mail](docs/development/local-development.md#61-publishing-visibility-without-mail).

`pnpm dev` prints a safe database summary, for example:

```text
persistence  SQLite (apps/api/data/no-wave.sqlite)
```

See [Local development](#local-development) for the exact reset, troubleshooting, and optional Docker PostgreSQL steps.

## Product and engineering direction

The product is a reading and publishing space for Chinese-language literature and digital art. The new product must preserve the old product's human rhythm, reading gravity, and Chinese-first presentation while making the experience lighter across devices and easier to perceive as a coherent product.

Design is a first-class workstream, not decoration added after engineering. The design language must be documented before large-scale implementation, and the shipped single Web implementation is the React Router app in `apps/web-rr`. The current visual design system is still at a concept stage; see the [UI design system (concept)](packages/web-ui/docs/UI_DESIGN_SYSTEM.md), which separates finished technical decisions from visual proposals.

The implementation is intentionally a **full-stack pnpm monorepo**: one Web application, one API service, and shared contracts and UI primitives. This keeps the architecture reviewable before any multi-service split. Since the API is a modular monolith with explicit application boundaries, a future service split does not require rewriting HTTP contracts or the Web application first.

The brand and first-article copy is already Chinese-first; product-facing UI copy lives in `packages/web-ui/src/lib/ui-copy.ts`, so locale expansion is a data problem rather than a rewrite. The editor route is now practical: Lexical provides established editor behavior, while the project focuses its custom work on publishing workflow, Chinese typography, and presentation. Old behavior embedded in Next.js pages is being mapped into framework-neutral shared packages, which is why the portability work ended with one framework instead of two.

Moderation, analytics and real-time clients remain incomplete. Mail-dependent email verification and password recovery are implemented but switched off until an operator enables `MAIL_ENABLED`; they are not pending implementation. See [Account mail: off until you switch it on](docs/operations/mail-setup.md). Image upload requires `MEDIA_S3_*` object storage configuration, so media writes return `503` until those variables are set.

## Current implementation status

- The local Web/API chain, the REST API contract tests, and the design-language documents are in place.
- Identity lifecycle, profile editing, article/comment publishing, notification inbox, moderation role checks, and the Web auth cookie boundary are implemented.
- The backend identity lifecycle is still an initial one. Mail-dependent verification/recovery are **off by default**, and moderation tools, real-time clients, and external push providers remain incomplete. A hardening pass is still required before a production launch.
- The current Web UI is the single React Router implementation and is functional; its visual design is still a concept-stage workstream rather than a finished design system.
- API authentication is Bearer-token based. Web clients authenticate through same-origin Web routes and receive an HttpOnly cookie; browser code does not hold a long-lived token in local storage.
- The old `API_GRAPHQL_URL` value is accepted for one transition release only and emits a deprecation warning. New code must use `/api/v1` REST paths; see [REST idempotency](docs/architecture/rest-idempotency.md).

The structured engineering review, architectural decisions, and roadmap live in [docs/audit](docs/audit), [docs/architecture/decisions](docs/architecture/decisions), and [docs/roadmap](docs/roadmap).

## Prerequisites

- **Node.js 24.x**, pinned by `package.json#engines` and CI. Node.js **24.15.0 or newer is recommended** for the SQLite provider because `node:sqlite` is a release-candidate API before that minor.
- **pnpm 10**, pinned by `packageManager`. Run `corepack enable` once if `pnpm` is not on your `PATH`.
- **Docker Desktop / Docker Engine**, only for the optional local PostgreSQL profile and container-image checks. The default SQLite path does not need Docker.

## Persistence runtime and deployment guidance

`DATABASE_PROVIDER` selects the runtime adapter:

- `sqlite` (default) uses Node's built-in SQLite driver and a local file.
- `postgres` uses the `pg` package, `DATABASE_URL`, and the versioned SQL migrations under `apps/api/migrations/postgres`.

SQLite remains the default for **local development** and single-host installs. **For production/server deployments, PostgreSQL is the recommended provider** while `node:sqlite` remains a release-candidate API. SQLite WAL is not cross-host replication or high availability. See [Persistence provider deployment guidance](docs/deployment/persistence-provider-guidance.md) and [ADR 0010](docs/architecture/decisions/0010-sqlite-first-and-online-provider-cutover.md) for operating boundaries, runtime-upgrade regression requirements, and conditions for revisiting the driver choice.

For the Neon production branch, PostgreSQL URLs, private media storage, and service provisioning, see [Neon deployment and operations](docs/operations/neon-deployment.md). **Do not use that page for routine local development**: it pulls production URLs into `.env.local`, and local probes write data. Account mail (password recovery, email verification) is built and **switched off**; nothing is sent until an operator sets `MAIL_ENABLED` in `.env.local`. See [Account mail: off until you switch it on](docs/operations/mail-setup.md).

## Observability

The API emits structured logs at `/metrics`, separate API and Web readiness probes, and article/comment metrics. Internal service configuration is never returned by `/metrics`; see [API observability](docs/operations/api-observability.md). Health and readiness are exercised by the local chain and CI.

## Local development

### Recommended: local SQLite (no Neon, no Docker)

Use this path unless you specifically need PostgreSQL provider parity.

1. Install dependencies:

   ```sh
   corepack enable
   pnpm install --frozen-lockfile
   ```

2. Generate the local environment file:

   ```sh
   pnpm setup:local
   ```

   This writes the git-ignored repository-root `.env.local` with `DATABASE_PROVIDER=sqlite`, `DATABASE_PATH=data/no-wave.sqlite`, and a randomly generated 48-byte `AUTH_JWT_SECRET`. It refuses to overwrite an existing file. Use `pnpm setup:local --force` to regenerate it.

3. Apply the schema. Migrations are an explicit step; `pnpm dev` does not mutate the schema automatically:

   ```sh
   pnpm db:migrate
   ```

4. Start both processes:

   ```sh
   pnpm dev
   ```

   `pnpm dev` starts both processes, reachable at `http://127.0.0.1:4000` (API) and `http://127.0.0.1:3000` (Web). It waits for both readiness gates and stops both with one `Ctrl+C`. It also prints which database it selected. `pnpm dev --check` runs the connectivity probe as soon as both are ready; `pnpm check:local` does the same in a second terminal.

5. Verify the chain:

   ```sh
   pnpm check:local
   ```

   The probe walks database → API → Web in dependency order. Use `pnpm check:local --read-only` to skip its write probes.

> **Why local first?** `pnpm check:local` deliberately creates a disposable account, profile and published article. Repeating that loop against a Neon/shared branch wastes quota and writes development rows into a shared database. Local SQLite is disposable, fast, and needs no credentials.

### Where is my data?

The default SQLite file is `apps/api/data/no-wave.sqlite`; WAL/SHM files sit beside it. `DATABASE_PATH` is resolved relative to `apps/api`, not the repository root. `pnpm dev` prints a **repository-relative** path so you can find the file without exposing your home directory in copied terminal output:

```text
persistence  SQLite (apps/api/data/no-wave.sqlite)
```

For a local PostgreSQL URL it prints a password-redacted URL. For an **external** URL it prints `PostgreSQL (external DATABASE_URL; host withheld)` and warns you to switch back to a local database. It never prints credentials, a full `DATABASE_URL`, a Neon hostname, a token, or a production path.

Shell exports take precedence over `.env.local`, and `.env.local` is ignored by Git. To reset a local SQLite database, stop `pnpm dev`, delete `apps/api/data/no-wave.sqlite*`, then run `pnpm db:migrate` again. Full option reference: `.env.example` and [Local development and local verification](docs/development/local-development.md).

### Avoid Neon during local development

- Do not paste pooled or unpooled Neon `DATABASE_URL` / `DATABASE_URL_UNPOOLED` values into `.env.local`.
- Do not run `neon env pull` before `pnpm dev`; it can overwrite `.env.local` with production URLs. If it already did, run `pnpm setup:local --force`.
- `pnpm setup:local --postgres` ignores an external `DATABASE_URL` inherited from the shell and writes the throwaway local compose URL instead.
- `pnpm dev` warns when `DATABASE_URL` or `DATABASE_URL_UNPOOLED` points to an external host. If you see that warning, unset both variables and regenerate `.env.local`:

  ```sh
  # macOS / Linux
  unset DATABASE_URL DATABASE_URL_UNPOOLED
  pnpm setup:local --force

  # PowerShell
  Remove-Item Env:DATABASE_URL, Env:DATABASE_URL_UNPOOLED
  pnpm setup:local --force
  ```

  Opening a new terminal also clears shell-only exports.

For deployment-only Neon steps, use [Neon deployment and operations](docs/operations/neon-deployment.md) in a separate environment, not the local development loop.

### Optional: local PostgreSQL in Docker

Use this only when you need PostgreSQL behavior (connection settings, the durable outbox, or the integration-test database). It is still local and still uses throwaway credentials.

```sh
pnpm db:up                         # postgres:17-alpine + bot_thk_dev + bot_thk_test
pnpm setup:local --force --postgres
pnpm db:migrate
pnpm dev
```

`pnpm db:down` stops the container but keeps the volume; `pnpm db:reset` stops it and deletes the volume. Uncomment `TEST_DATABASE_URL` in `.env.local` only if you want `pnpm test` to run the PostgreSQL integration suites. Never point `.env.local` at a shared, staging, or production database: the probe writes data.

### Verify and troubleshoot

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `SQLite schema is not current` | Migrations were never applied. | `pnpm db:migrate`. |
| `AUTH_JWT_SECRET is N bytes` | Empty or short secret. | `pnpm setup:local --force`. |
| Auth routes return `503` | API started with an invalid secret. | Restart with a valid `.env.local`. |
| Port `4000` or `3000` is in use | Another dev process is running. | Stop it, or set `PORT` / `WEB_PORT`. |
| Web page is empty while API steps pass | Web app is serving fixtures or cannot reach the API. | Check `API_BASE_URL=http://127.0.0.1:4000`, then run `pnpm check:local`. |
| `pnpm dev` warns about an external database | A Neon/shared URL is exported or stored in `.env.local`. | Unset `DATABASE_URL` / `DATABASE_URL_UNPOOLED` and run `pnpm setup:local --force`. |
| `fetch failed` against `localhost` | `localhost` resolved to `::1` while the API listens on IPv4. | Use `127.0.0.1` in `API_BASE_URL`. |

### One portable command

`pnpm stack:start` starts API, Web, migration and outbox-drain processes as plain `node` children with no Vercel binding. `pnpm stack:check` does the same and verifies the stack with one command. Both assemble the environment from documented variables rather than inheriting the whole shell. The default profile uses a throwaway local SQLite file; do not export a Neon `DATABASE_URL` before running them, because `stack:check` will honour it. See `scripts/portable-stack.ts`.

## Other checks and commands

| Command | Effect |
| --- | --- |
| `pnpm typecheck` | Typecheck every workspace. |
| `pnpm test` | Run the root unit and API contract test list. |
| `pnpm test:routes` | Route-level Web smoke checks. |
| `pnpm build` | Build the React Router Web app. |
| `pnpm dev --api-only` / `--web-only` | Start one process, for example when the API runs in a container. |
| `pnpm dev --check --exit` | Probe, then stop both processes; used by CI. |
| `pnpm check:local --read-only` | Verify the chain without write probes. |
| `pnpm verify:publish` | Verify writing-desk publish visibility without mail; prints article links. |

## PostgreSQL integration tests

The root `pnpm test` list can run without a database: `apps/api/src/persistence/sqlite.test.ts` runs locally, and PostgreSQL suites skip themselves when `TEST_DATABASE_URL` is absent. Set `TEST_DATABASE_URL` to a **disposable** database to opt in:

```sh
pnpm db:up
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bot_thk_test \
  pnpm --filter @bot-thk/api test:integration
```

On Windows PowerShell, set `$env:TEST_DATABASE_URL` before running the same command. `DATABASE_URL` and `DATABASE_URL_UNPOOLED` must not point at production when running migrations or integration tests.

## Database and URL configuration reference

- `DATABASE_PROVIDER` selects `sqlite` or `postgres`. Both providers use the same REST contract.
- `DATABASE_PATH` is resolved against `apps/api`; the default is `data/no-wave.sqlite`. Set it to `:memory:` only for ephemeral tests.
- `DATABASE_URL` is the PostgreSQL query URL. For local PostgreSQL, use the compose value in `.env.example`. `DATABASE_URL_UNPOOLED` is a deployment-only migration override.
- `DATABASE_AUTO_MIGRATE=true` is an opt-in convenience for throwaway local setups; the documented flow keeps `pnpm db:migrate` explicit.
- `API_BASE_URL` tells the Web server where the API is. `pnpm dev` wires this automatically; do not set it to a remote API for the local chain.
- `POSTGRES_PORT` changes the host port published by `compose.yaml`.
- Shell exports win over `.env.local`; `.env.local` wins over code defaults. Never put shared, staging, or production credentials in `.env.local`.

## CI

CI runs dependency installation, typecheck, Web/API tests, route smoke, container-image smoke, Playwright e2e, PostgreSQL integration, and the local-chain job (`pnpm dev --check --exit`) in separate stages. The GitHub Actions workflow is authoritative; the GitLab pipeline mirrors the verification stages. See `.github/workflows/ci.yml` and `.gitlab-ci.yml`.

## Lexical note

Some documents still use the phrase "portability/content spike" for the historical Web UI. That spike is retired: `apps/web-rr` is the single Web implementation. The design system documents are concept proposals, not a second framework or a deployed second UI.
