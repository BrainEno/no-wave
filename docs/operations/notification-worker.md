# Notification worker — standalone operation contract

- Date: 2026-10-29
- Amended: 2026-11-12 — [ADR 0038](../architecture/decisions/0038-notification-integrity.md), bounded retry and durable quarantine
- Code: `apps/api/src/persistence/notification-worker.ts` (entry point), `outbox-worker.ts` (batch dispatch), `message-notification-delivery.ts` (delivery), `outbox-metrics.ts` (metrics)
- Related: [frontend portability migration §Phase 2](../roadmap/frontend-portability-migration.md), [hosting qualification §5](../roadmap/hosting-qualification.md), ADR 0012 decisions 7–8

This document is the contract the Web migration depends on. It is a description of the worker that already exists; the process contracts below are exercised locally against disposable databases; no production deployment is implied.

## 1. Process model

The worker is a **separate long-running Node process**, not a timer inside the API or the Web server.

```
node src/persistence/notification-worker.ts        # pnpm --filter @bot-thk/api worker:notifications
```

Requirements: Node.js (same major as the API), and the same persistence configuration the API uses. The worker resolves its store through `createPersistenceRuntime`, so `DATABASE_PROVIDER`/`DATABASE_PATH`/`DATABASE_URL` configure it exactly as they configure the API — it is **not** PostgreSQL-only. Both adapters have had a durable `outbox_events` table since the lease-token migration; for a while the two entry points nevertheless rejected any configuration without `DATABASE_URL`, so a default SQLite deployment queued `message.created` events that nothing could deliver. It verifies connectivity via `store.health()` **before** entering the loop, and exits non-zero (`worker_failed_to_start`) if that check fails. The resolved provider is recorded in the `worker_started` log line.

> **SQLite caveat.** `node:sqlite` is synchronous, so a worker polling a SQLite file blocks its own event loop while it queries and competes with the API for the write lock (`BEGIN IMMEDIATE`, `busy_timeout` 5 s). That is acceptable for a single-host deployment draining on a schedule, but the long-lived worker is at its best against PostgreSQL.

## 2. Configuration

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `DATABASE_PROVIDER` | `sqlite` | `sqlite` \| `postgres` | Which adapter to drain; defaults follow the API (SQLite with no `DATABASE_URL`) |
| `DATABASE_URL` | — | — | PostgreSQL DSN; **required when** `DATABASE_PROVIDER=postgres`, and it selects Postgres implicitly when set without `DATABASE_PROVIDER` |
| `DATABASE_PATH` | `data/no-wave.sqlite` | — | SQLite file; **required when** the provider is SQLite, and it must already be migrated (the runtime refuses to start on a pending schema) |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | 100–60000 | Idle sleep between batches; also the back-off after a batch-level error |
| `OUTBOX_BATCH_LIMIT` | `25` | 1–100 | Maximum events claimed per batch |
| `OUTBOX_LEASE_SECONDS` | `60` | 1–3600 | Lease granted per claimed event |
| `OUTBOX_RETRY_DELAY_SECONDS` | `30` | 1–86400 | Base delay after the first failed attempt; doubles on subsequent attempts |
| `OUTBOX_MAX_RETRY_DELAY_SECONDS` | `86400` | 1–86400, ≥ base | Maximum exponential-backoff delay |
| `OUTBOX_MAX_ATTEMPTS` | `8` | 1–100 | Persisted delivery-attempt budget, including crashed leases |
| `OUTBOX_METRICS_PORT` | `0` (disabled) | 0–65535 | Opt-in Prometheus-style `/metrics` endpoint |
| `OUTBOX_METRICS_HOST` | `127.0.0.1` | — | Metrics bind address; loopback unless explicitly widened |
| `OUTBOX_METRICS_REFRESH_INTERVAL_MS` | `5000` | 1000–60000 | Backlog gauge refresh interval |

Out-of-range values are a **startup error**, not a warning: a typo cannot silently disable retries. Metrics stay off unless a port is set, and the metrics server has no authentication — do not bind it to a public interface.

## 3. Delivery semantics

- **At-least-once.** `dispatchOutboxBatch` claims exactly one event at a time (`claimOutboxEvents({ limit: 1, leaseSeconds, maxAttempts })`) immediately before delivering it, so a slow delivery cannot let later events in the same batch expire while they wait. Consumers must deduplicate by `eventKey`.
- **Lease ownership is enforced.** `markOutboxDelivered` requires the claim's `leaseToken`; a stale worker whose lease expired gets `false`, which is treated as a delivery failure rather than a silent success. `rescheduleOutboxEvent` is likewise lease-scoped: a superseded worker never postpones the current owner's lease.
- **Failures have a finite budget, never a silent drop.** Delay is `min(cap, base × 2^(attempts-1))`; at the budget, the fenced settlement records `dead_lettered_at` and clears the lease instead of scheduling again. `failed` includes retries, terminal failures and lost leases; `deadLettered` counts confirmed terminal failure settlements. A transition error aborts the batch, leaving the lease recoverable.
- **Crashes spend attempts too.** Claim quarantines up to 100 expired/exhausted rows in its own transaction before selecting ordinary work, whose query excludes exhausted and terminal rows. A live final lease can still finish successfully. If the process crashes, the next claim retires that lease only after expiry. This maintenance is journaled even when the claim returns no events; a subsequent tick can continue a larger sweep.
- **Idle behavior.** When a batch claims nothing, the loop sleeps `OUTBOX_POLL_INTERVAL_MS`. A batch-level exception is logged as `outbox_batch_failed` and followed by the same sleep — the process does not exit on transient database errors.

## 4. Logs and metrics

Logs are single-line JSON objects with `timestamp`, `level`, `component: "notification-worker"` and `event`. Event names used today: `worker_started`, `outbox_batch_completed`, `outbox_event_failed`, `outbox_batch_failed`, `outbox_metrics_listening`, `outbox_metrics_refresh_failed`, `outbox_metrics_server_error`, `worker_stopping`, `worker_failed_to_start`.

Error fields are reduced to a safe class name (`safeErrorName`): driver messages can contain SQL or infrastructure values and are never logged, and event payloads are never logged. `info` goes to stdout, `warn`/`error` to stderr, so a platform log splitter can route them differently.

`/metrics` (when enabled) exposes batch counters, delivery/failure counters and batch duration. The snapshot gauges `api_outbox_pending_events` / `api_outbox_oldest_pending_age_seconds` exclude dead letters but include delayed retries and live leases; `api_outbox_dead_letter_events` reports retained dead rows. A failed backlog read increments a failure counter and preserves the complete last-known snapshot rather than failing the scrape. Crash quarantine appears in the durable gauge, not a delivery callback counter. Failure diagnostics distinguish `retryScheduled`, `deadLettered` and the actual `retryDelaySeconds`; messages and payloads remain private.

## 5. Shutdown

`SIGINT`/`SIGTERM` set a stop flag only. The loop finishes the batch in progress, then runs the `finally` block: log `worker_stopping`, close the metrics server, `sql.end({ timeout: 5 })`. In-flight deliveries are therefore completed or rescheduled, never abandoned mid-write; anything still leased when the process dies is recoverable after lease expiry.

Operational rule: send `SIGTERM`, wait for exit, and only then start the replacement. Overlapping workers are safe for fenced state transitions (delivery remains at least once) but produce more lease churn than necessary.

## 6. What the hosting gate implies

The qualified zero-cost host (Render free web service, see [hosting qualification](../roadmap/hosting-qualification.md)) does **not** include a free background-worker or cron instance: those start on paid instances. The cardless option on that platform is a scheduler-invoked drain — a short-lived run that dispatches due outbox events once per interval against the same database.

## 6a. Scheduled drain (implemented 2026-10-29)

    pnpm --filter @bot-thk/api drain:notifications

A one-shot process: it opens the configured persistence runtime, checks
`store.health()`, drains what is due, logs a summary and exits **0** (or **1** on
failure, so a scheduler records it). Any external scheduler that can start a process — a
scheduled GitHub Action, cron-job.org, or a cron on any machine that can reach
the database — is enough.

**Why a process and not an HTTP endpoint.** A drain endpoint would need to be
reachable by the scheduler, which means a new public route, a shared secret in
the Web app's environment, and a cold start (up to ~30 s on a sleeping free
instance) on every tick. A one-shot process needs none of that: no new attack
surface, no secret, no dependency on the web instance being awake. The only
credential involved is `DATABASE_URL`, which the API already holds.

**Why it is safe to run more than one.** Events are claimed under a lease and
marked delivered by lease token, so an overlapping drain — or a drain alongside
the long-lived worker — cannot deliver an event whose lease it does not own.
Delivery remains at-least-once and consumers still deduplicate by `eventKey`.

**Why it is bounded.** `OUTBOX_DRAIN_DEADLINE_MS` (default 10 000 ms, 1–600 000)
and `OUTBOX_DRAIN_MAX_BATCHES` (default 20, 1–1000) stop one invocation from
pinning a 0.1-CPU instance or overrunning the scheduler's timeout. Remaining
events stay in the outbox and are picked up by the next tick — a backlog is
drained over several intervals, which is the intended behavior on a host this
small. The per-batch settings are the worker's: `OUTBOX_BATCH_LIMIT`,
`OUTBOX_LEASE_SECONDS`, `OUTBOX_RETRY_DELAY_SECONDS`,
`OUTBOX_MAX_RETRY_DELAY_SECONDS`, `OUTBOX_MAX_ATTEMPTS` (all validated, out of range
= startup error).

| Log event | Level | Meaning |
| --- | --- | --- |
| `outbox_drain_started` | info | settings in effect (batch limit, lease, retry, deadline, batch cap) |
| `outbox_drain_completed` | info (warn if any event failed) | `batches`, `claimed`, `delivered`, `failed`, `deadLettered`, `stopReason`, `durationMs` |
| `outbox_drain_failed` | error | a batch-level failure stopped the drain; `errorName` only |
| `outbox_drain_failed_to_start` | error | configuration or database failure before the first claim; exit code 1 |
| `outbox_event_failed` | warn/error | one event's delivery failed, as in the worker |

`stopReason` is one of `empty` (nothing left due), `deadline`, `batch-limit`,
`batch-failed`. Driver messages are never logged — only a safe error class — so a
connection string cannot reach the log stream.

The drain uses the same provider resolution as the API and the worker, so a
SQLite deployment is drained by exactly the same scheduled command. Two caveats
follow from the store, not from the command: the SQLite file must be reachable
from wherever the scheduler runs (a scheduled GitHub Action cannot open a file on
your laptop), and a drain and the API contend for the same write lock, which
`busy_timeout` resolves but does not make free.

## 7. Rollout, operations and verification

Apply PostgreSQL migration 0037 / SQLite 0024 with all old API writers, workers,
drains and migration jobs stopped. Restart them together with identical retry
settings; old binaries do not know how to exclude terminal rows. Existing rows
are retained, not purged or eagerly marked dead by the migration. Changing a
budget never resets a recorded dead letter. There is no automatic redrive,
public retry endpoint or retention purge. Alert on nonzero dead-letter depth,
inspect the restricted database and repair the underlying cause before separately
approving a replay. Never put event payloads or database credentials in logs.

| Contract | Automated evidence |
| --- | --- |
| Same like/follow identity across toggle/set, editions, actors and legacy random keys; read state unchanged | `engagement-notification-contract.test.ts`, identical cases for SQLite/PostgreSQL |
| Exponential/capped retry, finite budget, expired/crashed/stale leases, normal events behind poison rows, backlog separation | `outbox-retry-contract.test.ts`, identical cases for both providers |
| Policy bounds, final-attempt success, observer redaction and database-transition errors | `outbox-retry-policy.test.ts` |
| Atomic journal rollback, terminal-state replay, duplicate capture suppression, both offline-copy directions | `notification-migration-contract.test.ts` |
| Occupied old-schema upgrade, live-lease/history preservation, terminal-state database CHECKs and idempotent rerun | `notification-schema-upgrade.test.ts` |
| Real worker/drain subprocesses, live metrics scrape, private-payload canaries and graceful SIGTERM | `notification-process-contract.test.ts`, both providers |
| External scheduler, deployed listener and platform shutdown | Not run; no deployment authorized |

Set `TEST_DATABASE_URL` for the real PostgreSQL cases. The root `pnpm test` and
API integration inventory include these files; source-head CI must independently
run the PostgreSQL service and complete browser/container gates. Local embedded
PostgreSQL is a real engine, not a replacement for those required checks.
