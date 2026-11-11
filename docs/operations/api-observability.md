# API observability

## Structured request logs

The API writes one JSON object per completed HTTP request to stdout, or stderr for warning/error results. Each event includes a server-generated `requestId`, a validated W3C `traceparent` trace ID (or a generated fallback), a bounded route label, normalized method, HTTP status, elapsed milliseconds and a level. The response returns the generated ID in `X-Request-Id`.

The `route` label is the **matched route id** from the route table (`articles.item`, `me.notifications.read-all`, `imports.notion`, …) — never the URL, never a slug or an id from the path. A request that matched no route keeps the generic `/api/v1/*`, because there is nothing to name. This is what makes a terminal readable: "one endpoint is being hammered" and "the API is being hammered" are different facts, and the label is the only place the difference can appear. `405` also names the route it refused.

**Successful liveness and readiness probes are counted but not logged.** `/health`, `/ready` and `GET /api/v1/health` are timers, not readers: a host probing every second would otherwise be the loudest line in the output, and a client stuck in a loop would bury every line that matters. They stay in the metrics (count and latency are the point) and a **failing** probe is still logged, because that is the one an operator has to see.

**A client in a loop is reported once.** When one route completes 200 requests inside a second, the API writes a single `http_request_flood` warning (`level: warn`, `route`, `requestsPerSecond`) and then stays quiet about that route for 30 seconds. Nothing is refused — every one of those requests was answered correctly — but the line says plainly where the traffic is coming from, which is the question a scrolling terminal cannot answer.

The log schema is intentionally allowlisted. It does **not** include the raw request URL, query parameters, remote IP, cookies, authorization headers, request/response bodies or actor/user IDs. Unexpected handler failures return a sanitized 500 response and log `rest_unhandled_error` with the error class plus a message that has been through `redactDiagnostic` (`apps/api/src/infrastructure/log-redaction.ts`): DSN userinfo, `password=`/`token:`-style pairs and the values of the secrets this process reads from its environment are masked, the text is flattened to one line, and it is capped at 200 characters. The startup failure line (`api_startup_failed`) is redacted the same way, because a driver that was handed a malformed DSN can quote it back and the DSN contains its password.

Both lines exist on purpose: "the access log says 500 and nothing else" is not diagnosable, and a stale schema (`relation "featured_articles" does not exist`) is worth one line. Never log an arbitrary request object, a full stack, or an unredacted exception message.

## Liveness and readiness

`GET /health` is liveness only. `GET /ready` checks both persistence and JWT
configuration; it returns `200` only when both are ready, otherwise `503` with
`persistence` and `auth` each set to `ok` or `unavailable`. Responses are
`no-store` and do not include configuration values or database errors. Mail and
media are optional and are not covered by this probe.

The standalone API also validates `AUTH_JWT_SECRET` (at least 32 UTF-8 bytes),
`AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`, and optional
`AUTH_JWT_MAX_TTL_SECONDS` before opening the database or listening. Invalid
configuration exits nonzero with a redacted startup log naming the field. For an
embedded server, invalid configuration is reported by `/ready`; authenticated
requests that encounter it receive a sanitized `503`, not a `500`.

## Prometheus metrics

Enable API metrics explicitly with `API_METRICS_ENABLED=true`, then scrape `GET /metrics` from a trusted monitoring network. The endpoint is disabled by default and returns 404 otherwise. When enabled, the response is plain-text Prometheus exposition format and marked `Cache-Control: no-store`.

Current in-process metrics:

- `api_http_requests_total{method,route,status}`: completed request counter.
- `api_http_request_duration_ms_{bucket,sum,count}`: HTTP duration histogram in milliseconds.
- `api_http_active_requests`: currently active requests.
- `api_http_auth_failures_total{method,status}`: API responses with status 401 or 403.
- `api_persistence_operations_total{operation,outcome}`: persistence-port operation count, separated into success/error.
- `api_persistence_operation_duration_ms_{bucket,sum,count}`: persistence-port operation wall-clock duration in milliseconds.
- `api_identity_mail_deliveries_total{purpose,outcome}`: account-mail delivery attempts, by `password_reset` / `email_verification` and `sent` / `failed` / `skipped`.
- `api_identity_mail_delivery_duration_ms_{bucket,sum,count}`: wall-clock duration of one delivery attempt (including its retry).
- `api_background_task_failures_total{task}`: cleanup and notice work that failed — `identity-prune`, `tombstone-purge`, `tombstone-notifications` (see [scheduled maintenance](scheduled-maintenance.md)). The label is a closed set; an unrecognised task collapses to `other`. The error class is in the accompanying log line, not in a label.

The notification worker is a separate process. Enable its dedicated Prometheus listener with `OUTBOX_METRICS_PORT=9100`; `OUTBOX_METRICS_HOST` defaults to `127.0.0.1` and should only be changed to a reachable interface when the scrape network is restricted. The optional endpoint exposes:

- `api_outbox_events_claimed_total`, `api_outbox_events_delivered_total`, `api_outbox_events_failed_total`: delivery results.
- `api_outbox_pending_events`, `api_outbox_oldest_pending_age_seconds`: backlog depth and age, sampled every `OUTBOX_METRICS_REFRESH_INTERVAL_MS` milliseconds (default 5000).
- `api_outbox_batch_duration_ms_{bucket,sum,count}`, `api_outbox_batch_failures_total`, `api_outbox_backlog_read_failures_total`: worker duration and observability/dispatch failures.

The worker metrics listener is disabled unless a nonzero port is configured. For container or remote scraping, set `OUTBOX_METRICS_HOST` deliberately and enforce a private network policy; the listener has no authentication and must not be exposed to the public Internet.

Labels intentionally use a small fixed set (HTTP methods and route ids from the route table, plus `/health`, `/ready`, `/metrics` and `/not_found`). Resource IDs, query values, users, IP addresses and exception text never become metric labels; the transport assigns the route id once, validated against the id shape, so neither a handler nor a URL can invent a series. Persistence timing measures complete application persistence-port calls (including adapter logic), not individual SQL statements.

Metrics are in-memory, process-local counters; a restart resets them. Scrape and aggregate every API instance separately. Do not expose `/metrics` publicly: restrict it with the deployment network or trusted reverse-proxy/ingress policy. The endpoint does not reveal identities or payloads, but traffic and operation rates are operational information.

## Alerting on account mail

Recovery is the one flow that can be completely broken while every HTTP metric
looks healthy: `POST /api/v1/auth/forgot-password` answers `202` whether or not
the mail went out, because the token is already stored and telling the caller
would reopen the account-enumeration question. So the delivery counter is the
**only** signal that recovery is working.

```
# No recovery mail has been delivered for two hours while requests kept coming.
sum(increase(api_identity_mail_deliveries_total{purpose="password_reset",outcome="sent"}[2h])) == 0

# More than a fifth of the last hour's attempts failed.
sum(rate(api_identity_mail_deliveries_total{outcome="failed"}[1h]))
  / clamp_min(sum(rate(api_identity_mail_deliveries_total[1h])), 1) > 0.2
```

Both rules need traffic to mean anything; on a quiet site, pair them with the
`identity_mail_failed` log line, which is emitted at `error` level with the
purpose and the SMTP error code. There is no queue and no retry after the
request ends: a transient relay failure is retried **once, inside the request**,
and a failure that survives that is final — the user asks again and gets a new
link.

## Alerting on background cleanup

The cleanup sweeps are the mirror image of account mail: no request is waiting
for them, so a purge that has been failing since Tuesday produces a perfectly
healthy-looking API and a recycle bin that keeps growing. The counter is the
signal an alert rules on, and it only exists in the API process while the sweeps
run there — a scheduled `pnpm --filter @bot-thk/api maintenance` run reports its
failures in its own JSON log line instead (see
[scheduled maintenance](scheduled-maintenance.md)).

```
# A sweep has failed at least once in the last 24 hours.
sum(increase(api_background_task_failures_total{task=~".*-(prune|purge)"}[24h])) > 0
```

Each failure also writes one `background_task_failed` log record at `warn` with
`task`, `errorName` and, for the deletion notices, `failed` (how many readers
could not be told). The error **class** is all that travels: a driver message can
carry a connection string.

## Known boundaries

The API and worker metrics are process-local and reset when their process restarts. The API trace ID is correlation metadata only; it does not create distributed spans and there is no OpenTelemetry exporter in this change. Optional OTLP tracing can be evaluated separately once an endpoint, sampling policy, and sensitive-attribute allowlist are specified.

For a production release, configure a metrics scraper, retention, dashboards, alert thresholds, log collection, and restricted network access in the actual deployment environment. The repository does not configure external alerting services or production infrastructure automatically.
