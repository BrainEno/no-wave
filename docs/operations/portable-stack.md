# One portable command: the whole stack on plain Node.js

> The host-side half of deployment qualification — sleep/wake, cold starts on a
> real instance, log drains, the platform's shutdown signal — is in
> [Host qualification](host-qualification.md). Nothing there has been run
> against a host yet.

`pnpm stack:start` and `pnpm stack:check` bring up the entire application —
database migration, API, React Router Web server — on a standard Node.js
runtime, using only the environment variables documented in `.env.example`.
Nothing in the path depends on Vercel, on a Next.js adapter, or on a platform
service binding.

This is Phase 6, item 1 of the [frontend portability
migration](../roadmap/frontend-portability-migration.md): the step that turns
"the migration target works" into "nobody needs the platform binding".

## The two commands

```sh
pnpm stack:start     # build, migrate, start, then keep running until Ctrl+C
pnpm stack:check     # build, migrate, start, probe, stop, exit non-zero on failure
```

Both are the same program, `scripts/portable-stack.ts`. `stack:start` prints
the two URLs and waits; `stack:check` runs a ten-step probe, prints a report and
exits `1` if any step failed (`2` for a bad command line). Use `stack:start`
when you want to click around, `stack:check` when you want an answer.

What the command does, in order:

1. `pnpm --filter @bot-thk/web-rr build` — the React Router production build, so
   the command works from a clean checkout.
2. `node apps/api/src/persistence/migrate.ts` — the explicit migration step.
   Migrations are never automatic, and this command does not make them so.
3. `node apps/api/src/server.ts` — the API.
4. `node apps/web-rr/server.ts` — the React Router Web server, **not** the
   Next.js app. That is the point: the command proves the migration target.
5. `node apps/api/src/persistence/notification-worker.ts` — only with
   `--worker`, and only when `DATABASE_URL` is set. The default is the cardless
   path instead: the probe writes a direct message, the outbox holds it, and a
   one-shot `notification-drain.ts` delivers it — the shape a free host
   schedules. The long-lived worker is what a self-hosted deployment runs.

Ports are reserved on ephemeral ports, so several stacks — yours, a CI job, a
second branch — can run at once without colliding.

| Flag | Effect |
| --- | --- |
| `--keep` | Do not stop the processes after the probe (`stack:start` sets this). |
| `--json` | Print the report as JSON instead of a table. |
| `--database-url=<dsn>` | Use this PostgreSQL DSN instead of SQLite. |
| `--database-path=<file>` | Use this SQLite file instead of a throwaway one. |
| `--worker` | Start the long-lived notification worker (PostgreSQL only) instead of relying on the one-shot drain. |
| `--help` | Print usage. |

Any other argument is a usage error (exit `2`), not a silent default.

## The environment contract

Every child process receives **the operating-system minimum plus its own role
variables, and nothing else**. The whole point of the command is that the stack
runs on what it is told, so a variable the developer's shell happens to export
is not allowed to be the reason it works.

**Inherited from the parent process (OS minimum):**
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`,
`SystemRoot`, `COMSPEC`, `LANG`, `LC_ALL`.

**Supplied by the command (the portable set, all documented in `.env.example`):**

| Variable | Role | Value the command chooses |
| --- | --- | --- |
| `DATABASE_PROVIDER` | all | `postgres` when a DSN is configured, otherwise `sqlite` |
| `DATABASE_PATH` | all | a throwaway file under the temp dir, or your documented `DATABASE_PATH` |
| `DATABASE_URL` | all | the DSN, when configured |
| `DATABASE_URL_UNPOOLED` | all | the same DSN (pooler-neutral) |
| `AUTH_JWT_SECRET` | all | see below |
| `AUTH_JWT_ISSUER` | all | the Web origin the command chose |
| `AUTH_JWT_AUDIENCE` | all | `no-wave` |
| `PORT` | API, Web | the reserved port for that role |
| `HOST` | API, Web | `127.0.0.1` |
| `API_BASE_URL` | Web | `http://127.0.0.1:<api port>` |
| `NEXT_PUBLIC_SITE_URL` | Web | `http://127.0.0.1:<web port>` |

`DATABASE_URL`, `DATABASE_PATH` and `AUTH_JWT_SECRET` are read from your
environment first; the rest are derived. Because every name above must appear in
`.env.example`, `scripts/portable-stack.test.ts` fails when the command starts
relying on an undocumented variable — the documentation is a tested property,
not a promise.

**Deleted from every child environment (the platform set):**
`API_SERVICE_URL`, `API_GRAPHQL_URL`, `VERCEL`, `VERCEL_URL`, `VERCEL_ENV`,
`VERCEL_REGION`, `VERCEL_GIT_COMMIT_SHA`.

### Why deletion rather than an empty value

`API_SERVICE_URL` is Vercel's private service binding: the Next.js app falls
back to it when `API_BASE_URL` is unset. A deployment that needs it cannot run
anywhere else, so "关掉 `API_SERVICE_URL` 一切照常" has to be demonstrated, not
asserted. Deleting the variable is stronger than emptying it: an empty string
still proves a code path was taken to ignore it, while absence proves no code
path read it. The probe's last check, `no-platform`, reports that all seven
names are absent from a live child's environment.

Setting them anyway changes nothing:

```sh
VERCEL=1 API_SERVICE_URL=http://127.0.0.1:9 pnpm stack:check
# → 9 passed, 0 failed, 1 skipped; no-platform: 7 platform variables absent
```

The URL above points at a closed port. If anything in the stack read the
binding, the run would fail. It does not.

### `AUTH_JWT_SECRET` is never fatal

A missing secret is replaced by `randomBytes(48).toString("hex")` and one
warning: the stack starts, and no session survives a restart. A supplied secret
shorter than 32 characters is replaced too, because the API refuses short ones.
Set `AUTH_JWT_SECRET` (or run `pnpm setup:local`) when you want sessions to
outlive the command.

## The probe

`stack:check` probes over HTTP only — it never imports application code, so what
it proves is what a browser would see. Steps run from the lowest layer up, and
the report prints a remedy for each failure.

| Step | What it proves |
| --- | --- |
| `api.health` | the API process answers `GET /health` |
| `api.ready` | the API reached the database (`GET /ready`) |
| `web.home` | the Web app renders server-side, with a title and the site shell |
| `identity.register` | two accounts register and the author's profile is created |
| `web.auth` | login sets HttpOnly cookies, the session resolves, no token in the body |
| `web.authoring` | the writing desk publishes an article through the same-origin proxy |
| `web.article` | the published page is server-rendered HTML containing the title |
| `web.comments` | a second reader comments and reads the comment back |
| `outbox.drain` | a reader's direct message is delivered by a one-shot drain outside the Web server (PostgreSQL only) |
| `no-platform` | none of the seven platform variables is present in a live child |

Each step reports `pass`, `FAIL` or `skip`. `outbox.drain` skips on SQLite —
the durable outbox is a PostgreSQL table — so a SQLite run ends with `9 passed,
0 failed, 1 skipped`; a PostgreSQL run reports ten passes and also exercises
`notification-drain.ts`, the one-shot path a cardless host schedules.

## PostgreSQL

```sh
pnpm db:up                                   # postgres:17-alpine from compose.yaml
pnpm db:up
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/bot_thk_dev' pnpm stack:check
```

When `DATABASE_URL` is set the provider flips to `postgres`, `DATABASE_PATH` is
dropped from the child environment, and the probe gains its tenth step: a reader
opens a conversation with the author and writes into it, the message sits in the
outbox, one `notification-drain.ts` run delivers it, and the author's inbox —
read through the Web tier's same-origin proxy — goes from 0 to 1. Nothing in the
Web server delivered it; that is what makes the free-host model (a scheduler
invoking the drain) something CI proves rather than assumes. Pass `--worker` to
run the long-lived worker instead.

## Continuous integration

CI runs the command on both providers, in the `portable-stack` job of
`.github/workflows/ci.yml`. The job sets no platform variable at all, so a
Vercel binding cannot be what makes CI green. On the PostgreSQL leg the job also
covers the outbox drain, which no local SQLite run can.

## What this command does *not* do

- It does not build a container image — [the images](#container-images) are
  built by CI, not by this command. Running one needs `docker`, which the
  command deliberately does not require.
- It does not start the Next.js app. `pnpm dev` still does that, and still
  serves the migration's baseline on :3000.
- It does not send mail. The outbox check is an in-app notification; account mail
  stays switched off until an operator sets `MAIL_ENABLED` — see [Account
  mail](mail-setup.md).
- It does not deploy anything. Cold-start numbers in the report are a laptop's;
  the host-side procedure is [Host qualification](host-qualification.md).
- It does not touch a deployment, DNS entry or production database. Running it
  needs no account anywhere.

## Container images

Two images, both built from the repository's single lockfile, both plain
`node:24-alpine`:

| Image | File | Build | Serves |
| --- | --- | --- | --- |
| API | `apps/api/Dockerfile.vercel` | production dependencies only | `node apps/api/src/server.ts` |
| Web | `apps/web-rr/Dockerfile` | two stages: build with devDependencies, then production dependencies only | `node server.ts` |

The filename of the API image is a leftover from the Vercel era; the file itself
contains nothing Vercel-specific (it is referenced by `vercel.json`, so renaming
it belongs to Phase 7, not to a cleanup nobody asked for).

**Why the Web image has two stages.** The build needs `vite`, `@react-router/dev`
and — because the prototype compiles the shared source tree in `apps/web/src`
through the `@/*` alias — that tree's own dependencies (Lexical, gsap); the
runtime needs none of them. Installing production dependencies
only in the runtime stage is also a test of the dependency graph: anything
`server.ts` imports at boot has to be a real dependency. That test caught a real
defect — `@react-router/node` was a devDependency even though the production
server imports `createRequestListener` from it, so a `--prod` install produced
an image that could not start. It is a `dependency` now.

**Running it.** The container's entrypoint needs no platform variable:

```sh
docker build -f apps/web-rr/Dockerfile -t bot-thk-web-rr .
docker run --rm -p 3100:3100 \
  -e API_BASE_URL=https://api.example.example \
  -e NEXT_PUBLIC_SITE_URL=https://www.example.example \
  bot-thk-web-rr
```

`PORT` defaults to 3100 and `HOST` to `0.0.0.0`. The server starts from
`/app/apps/web-rr` because `server.ts` resolves `RR_BUILD_DIR` and
`RR_SERVER_BUILD_DIR` relative to the working directory — the same reason
`pnpm --filter @bot-thk/web-rr start` runs from the application directory.
Migrations are never run by the image; they are an explicit step, inside a
container as much as on a host.

**How it is verified.** The CI `container-image` job builds both images, starts
them on one network — the Web container reaching the API through `API_BASE_URL`
alone — and probes them from outside: `/health` and `/ready` on the API, and the
home page (200, server-rendered title, site shell) plus a 404 on an unknown
route from the Web container. No image is built inside this repository's
sandbox, so those assertions are the only evidence that the images work, and
they run on every pull request.

The same job also measures the Web container's cold start (`docker run` to the
first answered request) and starts it again after `docker stop`, which is the
closest available analogue of a free instance waking up — and, because
`docker stop` sends SIGTERM, it exercises the server's graceful shutdown on the
way.
