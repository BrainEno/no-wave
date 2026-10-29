# Local development and local verification

This document is the contract for running the whole product on one machine: a
database, the REST API, the Web app, and a script that proves the three are
actually connected. It also records why the tooling looks the way it does, and
which gaps in the previous setup it closes.

Scope: developer machines only. Nothing here is a deployment procedure. See
[Vercel deployment](../deployment/vercel.md) and
[persistence-provider deployment guidance](../deployment/persistence-provider-guidance.md)
for that.

## 1. The chain, in one screen

```sh
# once, after `pnpm install`
pnpm setup:local          # writes .env.local with a generated 48-byte JWT secret

# SQLite (default)
pnpm db:migrate           # create apps/api/data/no-wave.sqlite
pnpm dev                  # API :4000 + Web :3000, with readiness gates

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

## 2. What was missing before

Each row was reproduced on the commit this document was written against
(`9f4da47`), not inferred from the code.

| # | Gap | How it showed up | Now |
| --- | --- | --- | --- |
| G1 | No local PostgreSQL orchestration. The README asked for a hand-written `docker run`, a manual `pg_isready` loop and a hand-typed `TEST_DATABASE_URL`. | Every developer invented their own container, port and database name. | `compose.yaml` + `pnpm db:up/db:down/db:reset`; the volume also creates `bot_thk_test`. |
| G2 | `.env.example` set `DATABASE_PROVIDER=postgres` with an empty `DATABASE_URL`, contradicting the SQLite-first default (ADR 0010). | Copying the template made the API exit at startup with `DATABASE_URL is required when DATABASE_PROVIDER=postgres.` | Template is SQLite-first, PostgreSQL is a documented switch, and `pnpm setup:local` writes a valid file. |
| G3 | A repository-root `.env.local` was read by the API but ignored by the Web app (Next.js only reads `.env*` from `apps/web`). | `API_BASE_URL` set "in the project env" had no effect on the Web app, which silently kept rendering fixtures. | `apps/web/next.config.ts` loads the same root file via `process.loadEnvFile`, with the same precedence rules as the API. |
| G4 | No single command for the API. Root `pnpm dev` started only the Web app. | Two terminals, two working directories, and an easy way to forget the API entirely. | `pnpm dev` starts both with readiness gates; `dev:api` / `dev:web` start one. |
| G5 | `AUTH_JWT_SECRET` shorter than 32 bytes or absent was only reported as `503 SERVICE_UNAVAILABLE` / "Identity is not configured." on auth routes. | Sign-in looked like an outage on a fresh clone; the message names neither the variable nor the length. | `evaluateAuthSecret` blocks `pnpm dev` before any process starts, with the exact remedy. |
| G6 | No way to test the chain. `pnpm test:routes` covers the Web app in fixture mode only. | "It works" was a manual browser opinion. | `pnpm check:local` (10 probes) and `pnpm dev --check`. |
| G7 | The publish precondition was undocumented. | Publishing without a profile returns `author: null`, so the public article 404s and the Web page 404s. | The probe writes a profile before publishing, and the doc explains why. |
| G8 | An empty database and a missing API look identical in the UI (both render an empty site). | Hours lost to "the frontend is not connecting". | The probe asserts the API title appears in the server-rendered HTML. |
| G9 | Next.js only serves dev assets to trusted hostnames. | Opening the dev server from a phone or a preview proxy produced an unstyled page. | `WEB_DEV_ALLOWED_ORIGINS` -> `allowedDevOrigins`. |
| G10 | The local chain was not exercised in CI. | Regressions in the wiring were only found by developers. | A `local-dev-chain` CI job boots SQLite *and* PostgreSQL legs through the same scripts. |
| G11 | `DATABASE_PATH` is resolved against the API's working directory, not the repository root. | `data/no-wave.sqlite` could land in two different places depending on how the API was started. | The dev banner prints the resolved absolute path. |

## 3. Defect found while verifying the chain

The new probe failed its Web auth step with `403 ORIGIN_REJECTED` even though the
request was same-origin. Root cause: Next.js builds `request.url` from the
hostname the server was started with, so `next dev --hostname 0.0.0.0` (and the
Web image's `HOSTNAME=0.0.0.0`) produces `http://0.0.0.0:3000/...`, while the
browser sends `Origin: http://127.0.0.1:3000`. `isSameOriginMutation` compared
against the first value and therefore rejected every legitimate sign-in,
logout, authoring write, media upload and comment mutation for any hostname other
than the listen address.

Fix: compare the browser `Origin` against the request's `Host` header (the
authority the browser actually addressed), falling back to `request.url` when the
header is missing or malformed. The comparison remains exact origin equality —
scheme, host and port — so a foreign origin, a different port or a scheme
downgrade is still rejected. See
`apps/web/src/lib/authoring-proxy-policy.ts` and its regression test.

## 4. How the pieces are organised, and why

```
package.json                 pnpm entry points; no shell-specific syntax, so they work in PowerShell
compose.yaml                 the only containerised piece: PostgreSQL 17
scripts/docker/postgres-init/one-shot SQL that creates bot_thk_test
scripts/lib/local-dev-config.ts   pure config/argument/secret logic (unit tested)
scripts/setup-local.ts       generate .env.local (idempotent, mode 0600)
scripts/dev.ts               start API + Web, readiness gates, one Ctrl+C
scripts/local-dev-check.ts   layered HTTP probe, PASS/FAIL/SKIP report
tsconfig.scripts.json        typechecks scripts/ (also repairs two pre-existing strict errors)
```

### 4.1 One environment file, one source of truth

A developer should not have to know that the API and the Web app load
configuration differently. The contract is:

1. A variable exported in the shell always wins.
2. `<repo>/.env.local` is the local file for both processes.
3. `apps/web/.env.local` still works (Next.js loads it) but is not required; the
   root file is what the docs and scripts use.
4. Defaults live in code (`apps/api` and `scripts/lib/local-dev-config.ts`).

`node --env-file-if-exists` (API) and `process.loadEnvFile` (Web) both refuse to
overwrite variables that already exist, so the precedence above is a property of
the runtime, not something each script re-implements.

### 4.2 Only the database runs in a container

The API and Web app run as native Node processes:

- hot reload, real file paths in stack traces, normal debugger attachment;
- no image rebuild per edit, so the inner loop stays in seconds;
- `pnpm check:local` probes exactly what a developer runs, including the
  `next dev` specifics that a container would hide (route compilation, dev
  assets, hostname handling).

The dependency that is genuinely easier to run in a container — a PostgreSQL
version with the right init scripts and a health check — is the one that is
containerised. This keeps one `compose.yaml` instead of an API image, a Web
image, a shared network and a separate build pipeline to maintain.

PostgreSQL is available but not the default. SQLite is the fresh-install default
per ADR 0010, and it is the fastest way to get a working API; PostgreSQL is a
one-flag switch for developers who need provider parity, connection settings or
the integration-test database.

### 4.3 The tooling talks over HTTP, never by importing app code

`scripts/*` never imports `apps/api` or `apps/web` modules. Consequences:

- the same probe verifies a SQLite file, a Docker PostgreSQL, a containerised API
  on another port, or staging (`--api-url`, `--web-url`);
- the probe cannot drift from a private implementation detail it does not own;
- the scripts stay typecheckable without the app build graph, and CI can run them
  against any deployment shape.

The cost is that `/ready` carries the "can the API query the database?" signal
rather than a direct SQL check in the script. That is the better boundary: the
API's own readiness endpoint is the contract the platform relies on, so testing
it also tests the production path.

### 4.4 Failure messages come before failures

`pnpm dev` refuses to start when it can predict a broken run:

- `AUTH_JWT_SECRET` missing or shorter than 32 bytes;
- port already in use (`PORT`, `WEB_PORT`);
- `API_BASE_URL` pointing somewhere other than the API it is about to start.

After startup it watches for the API's structured `api_startup_failed` event, so
a failed migration or an unreachable PostgreSQL stops the command in under a
second instead of waiting for a readiness timeout. `node --watch` keeps a crashed
API process alive, which is why the log event, not the exit code, is the signal.

### 4.5 Writes are explicit

`pnpm check:local` creates a disposable account, a profile and a published
article, then reads them back anonymously and through the Web app. That is the
only way to prove the identity, authorisation and publish paths of a fresh
database, and it is what makes "the Web page shows API data" a real assertion
rather than a screenshot.

Use `--read-only` to skip those steps. The probe never deletes anything, so
probe rows accumulate in a development database; `pnpm db:reset` (PostgreSQL)
or deleting `apps/api/data/` (SQLite) is the documented reset.

### 4.6 What was deliberately not added

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

## 5. Command reference

| Command | Effect |
| --- | --- |
| `pnpm setup:local` | Create `.env.local` with SQLite and a generated secret; refuses to overwrite. |
| `pnpm setup:local --postgres` | Same, selecting PostgreSQL and the compose connection URL. |
| `pnpm setup:local --print` | Print the file to stdout without writing. |
| `pnpm db:up` / `db:down` / `db:reset` | Postgres 17 up (waiting for healthy), stop keeping data, stop and delete the volume. |
| `pnpm db:migrate` | Apply migrations for `DATABASE_PROVIDER` (explicit step, no auto-migrate). |
| `pnpm dev` | API (`node --watch`) + Web dev server, readiness-gated. |
| `pnpm dev --api-only` / `--web-only` | Start one process (e.g. API in Docker, Web on the host). |
| `pnpm dev --check` | Run the connectivity probe once both are ready. |
| `pnpm dev --check --exit` | Probe, then stop both processes and exit with the probe result (CI, scripts). |
| `pnpm check:local` | Probe an already running chain. |
| `pnpm check:local --api-only` | Skip every Web layer, including the Web auth proxy (useful in CI or against a container). |
| `pnpm check:local --read-only` | Skip the write probes. |
| `pnpm check:local --api-url <url> --web-url <url>` | Probe another origin. |

Environment knobs: `HOST`, `PORT`, `WEB_HOST`, `WEB_PORT`, `DATABASE_PROVIDER`,
`DATABASE_URL`, `DATABASE_PATH`, `DATABASE_AUTO_MIGRATE`, `AUTH_JWT_*`,
`API_BASE_URL`, `WEB_DEV_ALLOWED_ORIGINS`, `TEST_DATABASE_URL`,
`POSTGRES_PORT` (compose host port). Every one is documented in `.env.example`.

## 6. What the probe asserts

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

## 7. PostgreSQL locally

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
  `TEST_DATABASE_URL` in `.env.local` to make `pnpm test` run the PostgreSQL
  suites; both `pnpm test` and `pnpm --filter @bot-thk/api test:integration` read
  `.env.local` for it.

The credentials are throwaway local values. Never point `.env.local` at a shared,
staging or production database: the probe writes data.

`DATABASE_URL_UNPOOLED` (optional) is preferred by `pnpm db:migrate`, matching the
Neon direct-connection guidance.

## 8. Verification levels

| Level | Command | Runtime | Needs Docker |
| --- | --- | --- | --- |
| Unit | `pnpm test` | seconds | no (PostgreSQL suites skip themselves) |
| Type | `pnpm typecheck` | seconds | no |
| Route smoke (Web, fixtures) | `pnpm test:routes` | ~1 min | no |
| Persistence integration | `TEST_DATABASE_URL=... pnpm --filter @bot-thk/api test:integration` | ~1 min | PostgreSQL |
| Local chain | `pnpm check:local` | seconds | only for the PostgreSQL profile |
| CI | `.github/workflows/ci.yml` | ~10 min | GitHub service container |

The CI `local-dev-chain` job runs exactly the documented commands —
`pnpm dev --check --exit` (SQLite) and `pnpm dev --api-only --check --exit`
(PostgreSQL) — so the developer path and the CI path cannot drift apart.

`pnpm test` runs the tooling's own unit tests
(`scripts/lib/local-dev-config.test.ts`, `apps/web/src/lib/dev-origins.test.ts`)
on every run, so the environment rules above cannot silently regress.

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `AUTH_JWT_SECRET is N bytes` from `pnpm dev` | Secret shorter than 32 bytes. | `pnpm setup:local --force`. |
| Auth routes return `503 SERVICE_UNAVAILABLE` without a startup error | The API is running with a missing/short secret (the REST layer masks it). | Restart with a valid secret; `pnpm dev` now checks this. |
| `DATABASE_URL is required when DATABASE_PROVIDER=postgres.` | PostgreSQL selected without a URL. | `pnpm db:up` and set `DATABASE_URL`, or switch to SQLite. |
| `SQLite schema is not current` | Never migrated after checkout. | `pnpm db:migrate`. |
| `Port 4000 is already in use` | A previous API/Web process is still running. | Stop it, or change `PORT` / `WEB_PORT`. |
| `Another next dev server is already running` | Next.js allows one dev server per app directory. | Stop the other one; do not run two `pnpm dev`s. |
| `web-render` fails, API steps pass | The Web app is serving fixtures (`API_BASE_URL` unset) or cannot reach the API. | Set `API_BASE_URL=http://127.0.0.1:4000` in the root `.env.local`, restart `pnpm dev`. |
| Page loads unstyled from another device | Next.js dev origin allowlist. | Add the hostname to `WEB_DEV_ALLOWED_ORIGINS`. |
| `fetch failed` against `localhost` | `localhost` resolved to `::1` while the API listens on IPv4. | Use `127.0.0.1` in `API_BASE_URL`. |
| Web page 404 for an article you just created | Created without `publish: true`, or no author profile. | Update the profile, publish the article (the probe shows the full sequence). |
| `429 RATE_LIMITED` in the probe | 20 registrations per IP per hour. | Wait, or use `--read-only`. |
| `image upload returns 503` | `MEDIA_S3_*` is not configured. | Expected; see [Web authoring operations](../operations/web-authoring.md). |

## 10. Known limits

- `pnpm check:local` asserts the *chain*, not the UI: layout, motion, WebGL and
  accessibility still need a human or a browser test.
- Email verification, account recovery and the notification worker's external
  delivery remain unimplemented; the probe does not cover them. The worker can be
  started manually with `pnpm --filter @bot-thk/api worker:notifications`.
- The GitLab pipeline mirrors the GitHub verification stages but does not run the
  PostgreSQL chain job; the GitHub workflow is authoritative.
- Windows is supported by the scripts (no shell operators in `package.json`, no
  POSIX-only flags), but the documented commands are exercised on Linux/macOS in
  CI.
