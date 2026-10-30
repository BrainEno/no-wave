# API observability

## Structured request logs

The API writes one JSON object per completed HTTP request to stdout, or stderr for warning/error results. Each event includes a server-generated `requestId`, a validated W3C `traceparent` trace ID (or a generated fallback), a bounded route label, normalized method, HTTP status, elapsed milliseconds and a level. The response returns the generated ID in `X-Request-Id`.

The log schema is intentionally allowlisted. It does **not** include the raw request URL, query parameters, remote IP, cookies, authorization headers, request/response bodies, actor/user IDs or exception messages. Unexpected handler failures return a sanitized 500 response; only a sanitized error name is logged. Never add arbitrary request objects or driver exception messages to log records.

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

The notification worker is a separate process. Enable its dedicated Prometheus listener with `OUTBOX_METRICS_PORT=9100`; `OUTBOX_METRICS_HOST` defaults to `127.0.0.1` and should only be changed to a reachable interface when the scrape network is restricted. The optional endpoint exposes:

- `api_outbox_events_claimed_total`, `api_outbox_events_delivered_total`, `api_outbox_events_failed_total`: delivery results.
- `api_outbox_pending_events`, `api_outbox_oldest_pending_age_seconds`: backlog depth and age, sampled every `OUTBOX_METRICS_REFRESH_INTERVAL_MS` milliseconds (default 5000).
- `api_outbox_batch_duration_ms_{bucket,sum,count}`, `api_outbox_batch_failures_total`, `api_outbox_backlog_read_failures_total`: worker duration and observability/dispatch failures.

The worker metrics listener is disabled unless a nonzero port is configured. For container or remote scraping, set `OUTBOX_METRICS_HOST` deliberately and enforce a private network policy; the listener has no authentication and must not be exposed to the public Internet.

Labels intentionally use a small fixed set of HTTP methods and route groups. Resource IDs, query values, users, IP addresses and exception text never become metric labels. Persistence timing measures complete application persistence-port calls (including adapter logic), not individual SQL statements.

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

## Known boundaries

The API and worker metrics are process-local and reset when their process restarts. The API trace ID is correlation metadata only; it does not create distributed spans and there is no OpenTelemetry exporter in this change. Optional OTLP tracing can be evaluated separately once an endpoint, sampling policy, and sensitive-attribute allowlist are specified.

For a production release, configure a metrics scraper, retention, dashboards, alert thresholds, log collection, and restricted network access in the actual deployment environment. The repository does not configure external alerting services or production infrastructure automatically.
