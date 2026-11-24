# Local development and local verification

Status: active

This document is the contract for running the whole product on one machine: a
database, the REST API, a notification worker, the Web app, and scripts that prove they are
actually connected. For previous gaps and their original reproduction, see
[the archived development-chain history](../audit/local-development-history.md).

Scope: developer machines only. Nothing here is a deployment procedure. See
[the portable stack](../operations/portable-stack.md) — the same processes, built
into the container images CI runs — and
[persistence-provider deployment guidance](../deployment/persistence-provider-guidance.md)
for that.

> **Local database first.** Use SQLite by default, or the Docker PostgreSQL in
> `compose.yaml`. Do not point `.env.local` at Neon: `pnpm check:local` writes
> probe rows, and repeating a local loop against a managed branch wastes quota.
> `neon env pull` is a deployment operation; if it overwrote `.env.local`,
> regenerate the local file with `pnpm setup:local --force`.

## 1. The chain, in one screen

```sh
# once, after `pnpm install`
pnpm setup:local          # writes .env.local with a generated 48-byte JWT secret
                          # and the local SQLite provider (no Neon)

# SQLite (default)
pnpm db:migrate           # create apps/api/data/no-wave.sqlite
pnpm dev                  # API :4000 + worker health :4001 + Web :3000, readiness-gated
                          # (why 3000 and not the package's 3100: see Ports below)

# or PostgreSQL in Docker
pnpm setup:local --force --postgres
pnpm db:up                # postgres:17 + bot_thk_dev + bot_thk_test
pnpm db:migrate
pnpm dev

# prove it end to end, in a second terminal
pnpm check:local
```

`pnpm check:local` is the answer to "is my local API actually reachable from my
local Web app?" It walks the layers in dependency order and prints one line per
layer, so the first `[FAIL]` identifies the broken layer.

### Ports

| Process | Port | Where it comes from |
| --- | --- | --- |
| API | **4000** | `PORT`. The API's own default is 4000 too, so a bare `node apps/api/src/server.ts` lands in the same place. |
| Worker health | **4001** | `OUTBOX_HEALTH_PORT`; loopback by default, `/health` and `/ready` only. |
| Web, through the chain | **3000** | `WEB_PORT`, set explicitly for the child process by `pnpm dev` / `dev:web` / `stack:start`. `check:local` probes `:3000`. |
| Web, run inside the package | **3100** | `apps/web-rr/vite.config.ts` and `apps/web-rr/server.ts` default to 3100 when `PORT` is unset — `pnpm --filter @bot-thk/web-rr dev`, and the same default as the container image. |

The split is deliberate (ADR 0017): the orchestrated chain kept the 3000 every
document, probe and `WEB_DEV_ALLOWED_ORIGINS` value already used, while the
package default stayed at 3100 so that a bare `react-router dev` started beside a
running chain does not collide with it. Every orchestrated path passes `PORT`
explicitly, so which port you get depends on how you started the server, not on
what is in `.env.local` — `WEB_PORT=3000` in the chain does not change the
package default.

## 2. How the pieces are organised, and why

```
package.json                 pnpm entry points; no shell-specific syntax, so they work in PowerShell
compose.yaml                 the only containerised piece: PostgreSQL 17
scripts/docker/postgres-init/one-shot SQL that creates bot_thk_test
scripts/lib/local-dev-config.ts   pure config/argument/secret logic (unit tested)
scripts/setup-local.ts       generate .env.local (idempotent, mode 0600)
scripts/dev.ts               start API + worker + Web on one persistence config
scripts/lib/dev-supervisor.ts process-tree cleanup, watch failure and recovery supervision
scripts/lib/dev-service-probe.ts bounded role-aware readiness checks
scripts/local-dev-check.ts   layered HTTP probe, PASS/FAIL/SKIP report
tsconfig.scripts.json        typechecks scripts/
```

### 2.1 One environment file, one source of truth

A developer should not have to know that the API and the Web app load
configuration differently. The contract is:

1. A variable exported in the shell always wins.
2. `<repo>/.env.local` is the local file inherited by all three dev roles. Standalone API/worker/drain package commands additionally read `.env` first as a lower-priority fallback.
3. The root file is what the docs and scripts use; the Web app reads it once, at
   dev-server start, through `apps/web-rr/vite.config.ts`.
4. Defaults live in code (`apps/api` and `scripts/lib/local-dev-config.ts`).

Shell exports win over env files. For repeated Node `--env-file-if-exists` flags, the later file wins, so package commands list `.env` before `.env.local`; `process.loadEnvFile` preserves existing environment values. The orchestrator loads `.env.local` once before spawning every dev role.

### 2.2 Only the database runs in a container

The API, notification worker and Web app run as native Node processes:

- hot reload, real file paths in stack traces, normal debugger attachment;
- no image rebuild per edit, so the inner loop stays in seconds;
- `pnpm check:local` probes exactly what a developer runs, including the
  dev-server specifics that a container would hide (route compilation, dev
  assets, hostname handling).

The dependency that is genuinely easier to run in a container — a PostgreSQL
version with the right init scripts and a health check — is the one that is
containerised. This keeps one `compose.yaml` instead of an API image, a Web
image, a shared network and a separate build pipeline to maintain.

PostgreSQL is available but not the default. SQLite is the fresh-install default
per ADR 0010, and it is the fastest way to get a working API; PostgreSQL is a
one-flag switch for developers who need provider parity, connection settings or
the integration-test database.

### 2.3 The tooling talks over HTTP, never by importing app code

Runtime dev tooling and HTTP probes do not import application modules; integration test fixtures may import migration helpers for disposable databases. Consequences:

- the same probe verifies a SQLite file, a Docker PostgreSQL, a containerised API
  on another port, or staging (`--api-url`, `--web-url`);
- the probe cannot drift from a private implementation detail it does not own;
- the scripts stay typecheckable without the app build graph, and CI can run them
  against any deployment shape.

The cost is that `/ready` carries the "can the API query the database?" signal
rather than a direct SQL check in the script. That is the better boundary: the
API's own readiness endpoint is the contract the platform relies on, so testing
it also tests the production path.

### 2.4 Failure messages come before failures

`pnpm dev` refuses to start when it can predict a broken run:

- `AUTH_JWT_SECRET` missing or shorter than 32 bytes;
- occupied or colliding service ports (`PORT`, `OUTBOX_HEALTH_PORT`, `WEB_PORT`);
- process-private SQLite (`:memory:`), which cannot be shared with the worker;
- invalid `DEV_RECOVERY_TIMEOUT_MS` (1000–120000 ms, default 15000);
- `API_BASE_URL` pointing somewhere other than the API it is about to start.

Startup failures, unexpected child exit (even exit 0) and crashed applications behind Node watch mode stop all peers with a nonzero command status. Startup HTTP gates verify API/worker role identity, cap JSON at 8 KiB and bound both headers and body reads. After readiness, an observed gap is reported immediately; hot reload or transient failures have `DEV_RECOVERY_TIMEOUT_MS` to recover, otherwise the whole chain stops. A requested stop waits for durable cleanup, then force-terminates any remaining process tree within its bounded budget. Vite's observed CLI shutdown exit 143 is accepted only for that child, not for unsuccessful API/worker cleanup. Each API/worker also has `SERVICE_STARTUP_TIMEOUT_MS` (30000 by default), so a wedged initial database acquisition fails and tears down the chain instead of waiting forever.

### 2.5 Writes are explicit

`pnpm check:local` creates a disposable account and a published article, then
reads them back anonymously and through the Web app. Registration itself now
creates a default author profile in the same transaction; the probe still
updates that profile to prove the authenticated write path. This is the only way
to prove the identity, authorisation and publish paths of a fresh database, and
it is what makes "the Web page shows API data" a real assertion rather than a
screenshot.

Use `--read-only` to skip those steps. The probe never deletes anything, so
probe rows accumulate in a development database; `pnpm db:reset` (PostgreSQL)
or deleting `apps/api/data/` (SQLite) is the documented reset.

### 2.6 What was deliberately not added

- **CORS on the API.** Browsers never call the API origin directly: public pages
  are server-rendered, and every browser mutation goes to a same-origin Web route
  (`/api/auth/*`, `/api/authoring/*`, `/api/articles/*/comments`, `/api/media/*`)
  that attaches the token server-side. Adding CORS would widen the origin surface
  without enabling any supported flow.
- **Automatic migrations in `pnpm dev`.** Migrations stay an explicit step
  (`pnpm db:migrate`), matching the release process and ADR 0010. `pnpm dev` fails
  fast with the command to run instead of mutating a schema on startup.
  `DATABASE_AUTO_MIGRATE=true` remains an opt-in for throwaway setups.
- **A shared "run both containers" compose profile.** It would duplicate the
  native workflow with a slower loop and would not be what the probe tests.
- **Seeded demo content.** The probe's own write path covers the read-back
  assertion, and a fixture set would need its own maintenance contract.

## 3. Command reference

| Command | Effect |
| --- | --- |
| `pnpm setup:local` | Create `.env.local` with SQLite and a generated secret; refuses to overwrite. |
| `pnpm setup:local --postgres` | Same, selecting PostgreSQL and the compose connection URL. |
| `pnpm setup:local --print` | Print the file to stdout without writing. |
| `pnpm db:up` / `db:down` / `db:reset` | Postgres 17 up (waiting for healthy), stop keeping data, stop and delete the volume. |
| `pnpm db:migrate` | Apply migrations for `DATABASE_PROVIDER` (explicit step, no auto-migrate). |
| `pnpm dev` | API + independent worker (`node --watch`) + Web dev server, readiness-gated and supervised. |
| `pnpm dev --api-only` / `--web-only` | API + worker only / Web only (external API/worker). |
| `pnpm dev --check` | Run the connectivity probe once all selected roles are ready. |
| `pnpm dev --check --exit` | Probe, then stop all supervised processes and exit with the probe result (CI, scripts). |
| `pnpm check:local` | Probe an already running chain. |
| `pnpm verify:publish` | One-shot publishing-visibility check on a disposable stack; no mail service. |
| `pnpm verify:publish --keep` | Keep the stack and article links open until Ctrl+C. |
| `pnpm verify:publish --api-url <url> --web-url <url>` | Verify an already running chain. |
| `pnpm check:local --api-only` | Skip every Web layer, including the Web auth proxy (useful in CI or against a container). |
| `pnpm check:local --read-only` | Skip the write probes. |
| `pnpm check:local --api-url <url> --web-url <url>` | Probe another origin. |

Environment knobs: `HOST`, `PORT`, `WEB_HOST`, `WEB_PORT`, `DATABASE_PROVIDER`,
`DATABASE_URL`, `DATABASE_PATH`, `DATABASE_AUTO_MIGRATE`, `AUTH_JWT_*`,
`AUTH_REGISTER_IP_LIMIT`, `ARTICLE_TOMBSTONE_RETENTION_DAYS`, `API_BASE_URL`,
`OUTBOX_HEALTH_HOST`, `OUTBOX_HEALTH_PORT`, `DEV_RECOVERY_TIMEOUT_MS`,
`SHUTDOWN_GRACE_MS`, `SHUTDOWN_CLEANUP_MS`, `API_TIMEOUT_MS` (see
[upstream timeouts](../architecture/web-upstream-timeouts.md)),
`WEB_DEV_ALLOWED_ORIGINS`, `TEST_DATABASE_URL`, `POSTGRES_PORT` (compose host
port). Every one is documented in `.env.example`.

## 4. What the probe asserts

| Step | Endpoint | Proves |
| --- | --- | --- |
| `api-health` | `GET /health` | The API process is listening (no database involved). |
| `api-ready` | `GET /ready` | The configured adapter (SQLite or PostgreSQL) answers. |
| `rest-list` | `GET /api/v1/articles` | Routing, locale parsing and the read path. |
| `auth-register` | `POST /api/v1/auth/register` | JWT configuration is valid and identity writes land. |
| `profile-write` | `PUT /api/v1/me/profile` | Bearer authentication and an authorised write. |
| `article-publish` | `POST /api/v1/articles` | The publish path (after the profile prerequisite). |
| `public-read` | `GET /api/v1/articles/:slug` | Published content is anonymously readable. |
| `web-auth-proxy` | `POST :3000/api/auth/login` | Web -> API auth, the `Origin`/`Host` guard and the HttpOnly cookie boundary. |
| `web-render` | `GET :3000/articles/:slug` | The Web server reached `API_BASE_URL` and rendered API data (the title must appear in the HTML). |
| `web-comment-proxy` | `GET :3000/api/articles/:slug/comments` | The browser-facing same-origin proxy path. |

The numbering is the debugging order: fix the lowest failing layer first. A 503
on `auth-register` while `api-ready` passes is almost always the JWT secret; a
`web-render` failure while the API steps pass is almost always `API_BASE_URL`.

### 4.1 Publishing visibility without mail

Email verification does **not** gate publishing: `authoring-workspace.tsx`
offers the verification button, but an unverified account can still write and
publish. A work that the writing desk reports as published is usually invisible
for one of these reasons instead:

1. **No author profile (legacy accounts).** Registration now creates a default
   profile in the same transaction, but an older account can still have none. The
   API then returns `author: null`, and `mapArticle()` in
   `packages/web-ui/src/lib/api-content.ts` filters that article out of every
   public list and page. The writing desk shows "未设置" and can create one.
2. **The Web app is reading fixtures.** Without `API_BASE_URL`, the Web process
   renders its static fixture registry rather than the API that stored the work.
3. **Locale mismatch.** The writing desk currently hard-codes `locale: "zh-CN"`,
   so a newly published work appears at `/articles/...`, not `/en/articles/...`.
4. **Home is curated.** The home shelf is editor-selected; the archive
   (`/articles`) is the reliable "all published works" view.

`pnpm verify:publish` proves all four boundaries without a mail service. It
starts a disposable SQLite stack on free loopback ports with a random JWT secret,
assembles only the documented portable-stack environment (no `MAIL_*`), then:

- registers a disposable, unverified account;
- reads back the default author profile created by that registration;
- publishes through the same `/api/authoring/articles` proxy the desk uses;
- reads the article anonymously from the API detail and list endpoints;
- asserts the server-rendered article page and archive contain the title/body;
- prints the API, article and archive URLs.

By default it stops the processes and removes the temporary database. Use
`--keep` to leave the stack up and open the printed links,
`pnpm --silent verify:publish --json` for pure machine-readable output,
`--timeout <ms>` to widen cold-start budgets, or `--database-path <file>` to
keep the SQLite file. To verify an existing chain instead of starting one, pass
`--api-url` and `--web-url` together. The command never calls
`/api/v1/auth/verify-email`, `/api/v1/auth/forgot-password` or
`/api/v1/me/email-verification`.

## 5. PostgreSQL locally

```sh
pnpm db:up                  # postgres:17-alpine, health check, bot_thk_dev + bot_thk_test
pnpm setup:local --force --postgres
pnpm db:migrate
pnpm dev
```

`compose.yaml` publishes `POSTGRES_PORT` (default 5432) and creates two
databases:

- `bot_thk_dev` — what the API uses (`DATABASE_URL`);
- `bot_thk_test` — reserved for the integration tests. Uncomment
  `TEST_DATABASE_URL` in `.env.local` for `pnpm --filter @bot-thk/api test:integration`,
  which reads that file. The root `pnpm test` deliberately does not load env
  files; export `TEST_DATABASE_URL` explicitly to include PostgreSQL there.

The credentials are throwaway local values. Never point `.env.local` at a shared,
staging or production database: the probe writes data. `pnpm setup:local --postgres`
uses the local compose URL and ignores an external `DATABASE_URL` inherited from
the shell; `pnpm dev` also warns when `DATABASE_URL` or `DATABASE_URL_UNPOOLED`
points to an external host. If that happens, unset both variables and regenerate
`.env.local` with `pnpm setup:local --force --postgres`.

`DATABASE_URL_UNPOOLED` is for deployment migrations (for example Neon's direct
connection), not for the local development loop. Leave it unset locally.

## 6. Verification levels

| Level | Command | Runtime | Needs Docker |
| --- | --- | --- | --- |
| Unit | `pnpm test` | seconds | no (PostgreSQL suites skip themselves) |
| Type | `pnpm typecheck` | seconds | no |
| Route smoke (Web, fixtures) | `pnpm test:routes` | ~1 min | no |
| Persistence integration | `TEST_DATABASE_URL=... pnpm --filter @bot-thk/api test:integration` | ~1 min | PostgreSQL |
| Local chain | `pnpm check:local` | seconds | only for the PostgreSQL profile |
| Publish visibility (mail-free) | `pnpm verify:publish` | ~1 min | no |
| CI | `.github/workflows/ci.yml` | ~30 s per chain leg | GitHub service container |

The CI `local-dev-chain` job runs exactly the documented commands —
`pnpm dev --check --exit` (SQLite) and `pnpm dev --api-only --check --exit`
(PostgreSQL) — so the developer path and the CI path cannot drift apart. The
`verify` job also runs `pnpm --silent verify:publish --json`, so the mail-free
publish path is part of the required-checks gate.

`pnpm test` runs the tooling's own unit tests
(`scripts/lib/local-dev-config.test.ts`, `scripts/local-dev-check.test.ts`,
`packages/web-ui/src/lib/dev-origins.test.ts`) on every run, so the environment rules and
the probe's skip semantics cannot silently regress.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AUTH_JWT_SECRET is N bytes` from `pnpm dev` | Secret shorter than 32 bytes. | `pnpm setup:local --force`. |
| Auth routes return `503 SERVICE_UNAVAILABLE` without a startup error | The API is running with a missing/short secret (the REST layer masks it). | Restart with a valid secret; `pnpm dev` now checks this. |
| `DATABASE_URL is required when DATABASE_PROVIDER=postgres.` | PostgreSQL selected without a URL. | `pnpm db:up` and set `DATABASE_URL`, or switch to SQLite. |
| `SQLite schema is not current` | Never migrated after checkout. | `pnpm db:migrate`. |
| `Port ... is unavailable` | A previous API/worker/Web process is still running. | Stop it, or change `PORT` / `OUTBOX_HEALTH_PORT` / `WEB_PORT`. |
| The dev server refuses a second start | One dev server per app directory. | Stop the other one; do not run two `pnpm dev`s. |
| `web-render` fails, API steps pass | The Web app is serving fixtures (`API_BASE_URL` unset) or cannot reach the API. | Set `API_BASE_URL=http://127.0.0.1:4000` in the root `.env.local`, restart `pnpm dev`. |
| Page loads unstyled from another device | The dev server's host allowlist. | Add the hostname to `WEB_DEV_ALLOWED_ORIGINS`. |
| `fetch failed` against `localhost` | `localhost` resolved to `::1` while the API listens on IPv4. | Use `127.0.0.1` in `API_BASE_URL`. |
| `pnpm dev` warns about an external database | A Neon/shared `DATABASE_URL` or `DATABASE_URL_UNPOOLED` is exported in the shell or left in `.env.local`. | Unset both variables and run `pnpm setup:local --force` (or `--force --postgres`). |
| Web page 404 for an article you just created | Created without `publish: true`, or no author profile. | Update the profile, publish the article (the probe shows the full sequence). |
| Writing desk says published, but public pages are empty | Missing author profile, Web fell back to fixtures, or `/en/articles` was opened. | Run `pnpm verify:publish`; set `API_BASE_URL`, write the profile, and open `/articles`. |
| `429 RATE_LIMITED` in the probe | 20 registrations per IP per hour. | Wait, or use `--read-only`. |
| `image upload returns 503` | `MEDIA_S3_*` is not configured. | Expected; see [Web authoring operations](../operations/web-authoring.md). |
| `test:integration` fails with `Media materialization audit encountered unsupported or oversized data.` (`INVALID_DATA`) | The PostgreSQL cluster was initialised with `server_encoding = SQL_ASCII` — a hand-rolled `initdb` without `--encoding`, unlike `postgres:17-alpine`. The media audit and comparison refuse to decode rows they cannot prove are UTF-8. | Re-create the cluster with `initdb --encoding=UTF8 --locale=C`, or use `pnpm db:up`. Check with `SHOW server_encoding`. |

## 8. Known limits

- `pnpm check:local` asserts the *chain*, not the UI: layout, motion, WebGL and
  accessibility still need a human or a browser test.
- Mail-dependent email verification and account recovery are implemented but
  switched off until `MAIL_ENABLED` is set; `pnpm verify:publish` deliberately
  proves that publishing works with mail off, while the recovery flows themselves
  remain uncovered by that probe. The notification worker can be started manually
  with `pnpm --filter @bot-thk/api worker:notifications`.
- GitHub Actions is the only supported CI gate; the incomplete GitLab pipeline
  was removed. Forks using another provider must implement all required jobs.
- Windows is supported by the scripts (no shell operators in `package.json`, no
  POSIX-only flags), but the documented commands are exercised on Linux/macOS in
  CI.

## 9. Durable notification verification

The default dev chain is tested against real SQLite and PostgreSQL by
`scripts/dev-notifications.test.ts`: three roles, one persisted message, an
identical idempotent retry, recipient-only notification within 2 seconds of the
commit acknowledgement, anonymous denial and complete process/port shutdown.
`pnpm test:notification-delivery` repeats the HTTP delivery contract against an
already running **disposable** stack (`SMOKE_API_URL`, optional
`SMOKE_WORKER_URL`); it creates three accounts and a private conversation, so do
not point it at production. Container CI uses the same HTTP probe, not a fake
in-process drain. [ADR 0040](../architecture/decisions/0040-notification-service-operations.md)
and the [worker runbook](../operations/notification-worker.md) define health,
backlog thresholds, bounded shutdown and same-image role dispatch.
