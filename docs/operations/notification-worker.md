# Notification worker — standalone operation contract

- Date: 2026-10-29
- Code: `apps/api/src/persistence/notification-worker.ts` (entry point), `outbox-worker.ts` (batch dispatch), `message-notification-delivery.ts` (delivery), `outbox-metrics.ts` (metrics)
- Related: [frontend portability migration §Phase 2](../roadmap/frontend-portability-migration.md), [hosting qualification §5](../roadmap/hosting-qualification.md), ADR 0012 decisions 7–8

This document is the contract the Web migration depends on. It is a description of the worker that already exists; nothing here was moved, started or deployed as part of writing it.

## 1. Process model

The worker is a **separate long-running Node process**, not a timer inside the API or the Web server.

```
node src/persistence/notification-worker.ts        # pnpm --filter @bot-thk/api worker:notifications
```

Requirements: Node.js (same major as the API), `DATABASE_URL` pointing at PostgreSQL. There is no SQLite mode — the durable outbox is a PostgreSQL table. It opens one `postgres.js` connection pool for the whole lifetime of the process, verifies connectivity via `store.health()` **before** entering the loop, and exits non-zero (`worker_failed_to_start`) if that check fails.

## 2. Configuration

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `DATABASE_URL` | — (required) | — | PostgreSQL DSN; the same database the API writes to |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | 100–60000 | Idle sleep between batches; also the back-off after a batch-level error |
| `OUTBOX_BATCH_LIMIT` | `25` | 1–100 | Maximum events claimed per batch |
| `OUTBOX_LEASE_SECONDS` | `60` | 1–3600 | Lease granted per claimed event |
| `OUTBOX_RETRY_DELAY_SECONDS` | `30` | 1–86400 | Delay applied by `rescheduleOutboxEvent` after a failed delivery |
| `OUTBOX_METRICS_PORT` | `0` (disabled) | 0–65535 | Opt-in Prometheus-style `/metrics` endpoint |
| `OUTBOX_METRICS_HOST` | `127.0.0.1` | — | Metrics bind address; loopback unless explicitly widened |
| `OUTBOX_METRICS_REFRESH_INTERVAL_MS` | `5000` | 1000–60000 | Backlog gauge refresh interval |

Out-of-range values are a **startup error**, not a warning: a typo cannot silently disable retries. Metrics stay off unless a port is set, and the metrics server has no authentication — do not bind it to a public interface.

## 3. Delivery semantics

- **At-least-once.** `dispatchOutboxBatch` claims exactly one event at a time (`claimOutboxEvents({ limit: 1, leaseSeconds })`) immediately before delivering it, so a slow delivery cannot let later events in the same batch expire while they wait. Consumers must deduplicate by `eventKey`.
- **Lease ownership is enforced.** `markOutboxDelivered` requires the claim's `leaseToken`; a stale worker whose lease expired gets `false`, which is treated as a delivery failure rather than a silent success. `rescheduleOutboxEvent` is likewise lease-scoped: a superseded worker never postpones the current owner's lease.
- **Failures are retried, not dropped.** A delivery error reschedules the event with `OUTBOX_RETRY_DELAY_SECONDS` and increments `failed`. If rescheduling itself throws, the batch aborts with that error (the event stays leased until expiry, then becomes claimable again).
- **Idle behavior.** When a batch claims nothing, the loop sleeps `OUTBOX_POLL_INTERVAL_MS`. A batch-level exception is logged as `outbox_batch_failed` and followed by the same sleep — the process does not exit on transient database errors.

## 4. Logs and metrics

Logs are single-line JSON objects with `timestamp`, `level`, `component: "notification-worker"` and `event`. Event names used today: `worker_started`, `outbox_batch_completed`, `outbox_event_failed`, `outbox_batch_failed`, `outbox_metrics_listening`, `outbox_metrics_refresh_failed`, `outbox_metrics_server_error`, `worker_stopping`, `worker_failed_to_start`.

Error fields are reduced to a safe class name (`safeErrorName`): driver messages can contain SQL or infrastructure values and are never logged, and event payloads are never logged. `info` goes to stdout, `warn`/`error` to stderr, so a platform log splitter can route them differently.

`/metrics` (when enabled) exposes batch counters, delivery/retry counters, batch duration and — refreshed on an interval — `pending_events` and `oldest_pending_age_ms` from `outbox_events WHERE delivered_at IS NULL`. A failed backlog read increments a failure counter and degrades to the previously recorded values rather than failing the scrape.

## 5. Shutdown

`SIGINT`/`SIGTERM` set a stop flag only. The loop finishes the batch in progress, then runs the `finally` block: log `worker_stopping`, close the metrics server, `sql.end({ timeout: 5 })`. In-flight deliveries are therefore completed or rescheduled, never abandoned mid-write; anything still leased when the process dies is recoverable after lease expiry.

Operational rule: send `SIGTERM`, wait for exit, and only then start the replacement. Two workers are safe (leases prevent double delivery) but produce more lease churn than necessary.

## 6. What the hosting gate implies

The qualified zero-cost host (Render free web service, see [hosting qualification](../roadmap/hosting-qualification.md)) does **not** include a free background-worker or cron instance: those start on paid instances. The cardless option on that platform is a scheduler-invoked drain — an authenticated endpoint or CLI invocation that runs `dispatchOutboxBatch` once per interval against the same database.

That path is **not implemented**. It stays in Phase 5 with the requirement that it must not weaken delivery guarantees: a single drain invocation must use the same leasing, rescheduling and idempotency semantics, must be safe to run concurrently with a long-lived worker, and must never require the Web server to own delivery state.

## 7. Verification status

| Claim | Status |
| --- | --- |
| Batch dispatch, leasing, retry and dedup semantics | Covered by `apps/api/src/persistence/sqlite-outbox-worker-contract.test.ts`, `outbox-metrics.test.ts`, and the PostgreSQL integration suites |
| `SIGTERM` drains the current batch then closes the pool | **Not covered by an automated test**; reviewed from source only |
| Metrics endpoint behavior | Covered by `outbox-metrics.test.ts` (rendering); live scrape not exercised |
| Deployed execution model | Not chosen; no deployment exists for this worker outside the local chain |

No worker process was started while writing this document.
