# Scheduled maintenance — the one-shot cleanup run

- Date: 2026-11-07
- Code: `apps/api/src/persistence/maintenance.ts` (entry point), `apps/api/src/application/maintenance.ts` (the run), `apps/api/src/application/background-tasks.ts` (failure reporting)
- Related: audit finding F-22 in [full review 2026-11-02](../audit/full-review-2026-11-02.md); [notification worker](notification-worker.md) for the one-shot-process pattern this follows; [API observability](api-observability.md) for the counter

## 1. The defect this closes

The API has two cleanup sweeps:

| Sweep | Removes | Per-call cap |
| --- | --- | --- |
| `pruneExpiredIdentityState` | sessions past `expires_at`, their access tokens, closed rate-limit windows, spent revocations | 100 sessions, 512 rows each of rate-limit / revocation / token |
| `purgeExpiredArticles` | works whose soft delete is older than `ARTICLE_TOMBSTONE_RETENTION_DAYS` (default 30) | `limit` rows, default 100, maximum 500 |

Both were bounded and correct. Neither had a trigger of its own: they ran **only
as a side effect of someone else writing** — every 128 write rate-limit checks and
every 32 article writes. On a busy instance that is fine. On the instance this
project is actually deployed as — one author, a handful of readers, days with no
writes at all — "every 32 article writes" means *never*, so expired sessions
accumulated in the table and deleted works sat in the recycle bin past the date
the author had been shown.

That is the whole finding: not that the sweeps were wrong, but that a quiet
instance never ran them, and that when one did fail, the failure was swallowed by
`catch {}` — indistinguishable from "nothing to do".

## 2. Process model

A **one-shot process**, like the notification drain:

```
pnpm --filter @bot-thk/api maintenance        # node src/persistence/maintenance.ts
```

It opens the configured persistence runtime, checks `store.health()`, sweeps what
is due, writes one JSON summary line and exits. There is no long-lived scheduler
inside the API, no timer, no new HTTP route and no new secret: the only credential
involved is the database the API already uses.

**Why not a timer in the API?** A timer inside the process adds a lifetime to
reason about (startup, shutdown, several instances sweeping at once, an event loop
stalled behind a slow query) for work that a cron entry does better and that
survives a deploy without doing anything at all.

**Why not an HTTP endpoint?** Same reasoning as the drain: it would need a public
route, a shared secret in another service's environment and a cold start on every
tick.

**It is safe to overlap** with a running API or with another maintenance run.
Both sweeps are bounded per statement and each provider serializes its own
writes; a second run finds less to do and removes nothing twice. Two runs at the
same instant on SQLite contend for the write lock for the length of one short
transaction, which is why the recommended schedule is hourly, not every minute.

## 3. Configuration

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `DATABASE_PROVIDER` | `sqlite` | `sqlite` \| `postgres` | Which adapter to sweep; defaults follow the API |
| `DATABASE_PATH` | `data/no-wave.sqlite` | — | SQLite file, already migrated |
| `DATABASE_URL` | — | — | PostgreSQL DSN; required when the provider is postgres, and it selects postgres implicitly when set without `DATABASE_PROVIDER` |
| `ARTICLE_TOMBSTONE_RETENTION_DAYS` | `30` | 1–3650 | The **same** window the recycle-bin UI shows and the write-path sweep uses; one reader, so the promise and the deletion cannot disagree |
| `MAINTENANCE_MAX_PASSES` | `5` | 1–20 | Passes in one run |
| `MAINTENANCE_ARTICLE_LIMIT` | `100` | 1–500 | Tombstones removed per pass |

Out-of-range values are a **startup error**, not a warning: a cron entry with a
typo fails loudly on the first tick instead of quietly sweeping the wrong amount.
The retention window is the exception — an unparseable value there falls back to
the default (the longer, safer window), because the same variable is read by the
recycle-bin listing and both sides must read it the same way.

### Why passes, and why more than one

Each sweep is capped by its own store, so a backlog larger than one cap is drained
over several calls. A run repeats until a pass removes nothing (converged) or the
pass cap is reached. Five passes clear up to 500 sessions or 2 500 tombstones in
one run — far beyond what a quiet instance accumulates in an hour — and the cap is
what stops a run from turning into a loop nobody counted on.

`converged: false` with `ok: true` is the normal result of a genuinely large
backlog: it is not an error, the next tick continues.

## 4. Exit codes and logs

| Exit | Meaning |
| --- | --- |
| `0` | Both sweeps ran. Nothing to do, or a capped-but-successful drain |
| `1` | A sweep failed, or the process could not start (invalid setting, unreachable or unmigrated database) |

Logs are single-line JSON with `timestamp`, `level`, `component: "maintenance"`
and `event`. Stdout for `info`, stderr for `warn`/`error`.

| Event | Level | When |
| --- | --- | --- |
| `maintenance_started` | info | After `health()` succeeded; carries `provider`, `maxPasses`, `articleLimit` |
| `background_task_failed` | warn | As each sweep fails; carries `task` and `errorName` |
| `maintenance_completed` | info | Carries `passes`, `removed`, `failures`, `converged`, `removedNothing` |
| `maintenance_failed` | error | The run finished but a sweep failed (exit 1) |
| `maintenance_failed_to_start` | error | Nothing ran; `errorName`, plus `errorMessage` only for the run's own range validation |

A run that removed nothing logs `maintenance_completed` with
`removedNothing: true` at **info**, and that is the normal line. It is not a
warning: a scheduler that reported a quiet instance as an incident every hour
would be training its operator to ignore it.

`errorName` is the error **class only** — `RangeError`, `PostgresError`,
`SQLITE_ERROR`. Driver messages are never logged: they can contain the connection
string, SQL text and bind parameters.

## 5. Scheduling

Hourly, from anything that can start a process against the database.

```cron
# crontab on the host that runs the API
17 * * * * cd /srv/no-wave && pnpm --filter @bot-thk/api maintenance >> /var/log/no-wave-maintenance.log 2>&1
```

```yaml
# .github/workflows/maintenance.yml (excerpt): scheduled tick, env from secrets
on:
  schedule: [{ cron: "17 * * * *" }]
  workflow_dispatch:
jobs:
  maintenance:
    runs-on: ubuntu-latest
    env:
      DATABASE_PROVIDER: postgres
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @bot-thk/api maintenance
```

```ini
# systemd timer, if you prefer the host's scheduler
# no-wave-maintenance.service: ExecStart=/srv/no-wave/node_modules/.bin/... maintenance
[Timer]
OnCalendar=hourly
Persistent=true
```

Nothing in the repository installs any of these; pick one for the deployment.

**The opportunistic sweeps stay.** The write-path triggers (every 128 rate-limit
checks, every 32 article writes) still run, bounded and now reported. They are a
supplement, not the trigger: a host that has not installed this job yet still
cleans up whenever it happens to be busy.

## 6. What this run does not do

- **No object storage.** Deleting a work's rows leaves its uploaded images where
  they are; media deletion is an explicit call with its own reference check
  (#217).
- **No outbox drain.** Message notifications are delivered by
  `drain:notifications` / `worker:notifications`, which have their own contract
  ([notification worker](notification-worker.md)).
- **No vacuum.** On SQLite, deleted rows leave free pages in the file; the file
  does not shrink. That is a separate `VACUUM` decision, deliberately not taken
  here — it rewrites the whole database and is not something to run hourly.
- **No schema change and no semantic change.** Both sweeps keep the caps,
  timestamps and predicates they shipped with; this run only decides *when* they
  execute and *what happens to a failure*.
- **Nothing about the provider cutover.** ADR 0010's planning gates are untouched.

## 7. Verifying it

```
# A real database, seeded by hand, keeps nothing after the run:
node --test apps/api/src/application/maintenance.test.ts
```

The suite runs the two sweeps against an in-memory SQLite database: it seeds an
expired session, an expired access token, a closed rate-limit window and a
tombstone past retention, moves them into the past, runs maintenance once and
asserts every row is gone — then runs it a second time and asserts the run is a
no-op that converged. The fake-store tests pin the properties that matter to an
operator: bounded passes, a capped run that does not claim convergence, one sweep
failing without stopping the other, and a report that carries an error class and
never a driver message.
