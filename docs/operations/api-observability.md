# API observability

## Structured request logs

The API writes one JSON object per completed HTTP request to stdout, or stderr for warning/error results. Each event includes a server-generated `requestId`, a validated W3C `traceparent` trace ID (or a generated fallback), a bounded route label, normalized method, HTTP status, elapsed milliseconds and a level. The response returns the generated ID in `X-Request-Id`.

The log schema is intentionally allowlisted. It does **not** include the raw request URL, query parameters, remote IP, cookies, authorization headers, request/response bodies, actor/user IDs or exception messages. Unexpected handler failures return a sanitized 500 response; only a sanitized error name is logged. Never add arbitrary request objects or driver exception messages to log records.

## Prometheus metrics

Scrape `GET /metrics` from a trusted monitoring network. The response is plain-text Prometheus exposition format and marked `Cache-Control: no-store`.

Current in-process metrics:

- `api_http_requests_total{method,route,status}`: completed request counter.
- `api_http_request_duration_ms_{bucket,sum,count}`: HTTP duration histogram in milliseconds.
- `api_http_active_requests`: currently active requests.
- `api_http_auth_failures_total{method,status}`: API responses with status 401 or 403.
- `api_persistence_operations_total{operation,outcome}`: persistence-port operation count, separated into success/error.
- `api_persistence_operation_duration_ms_{bucket,sum,count}`: persistence-port operation wall-clock duration in milliseconds.

Labels intentionally use a small fixed set of HTTP methods and route groups. Resource IDs, query values, users, IP addresses and exception text never become metric labels. Persistence timing measures complete application persistence-port calls (including adapter logic), not individual SQL statements.

Metrics are in-memory, process-local counters; a restart resets them. Scrape and aggregate every API instance separately. Do not expose `/metrics` publicly: restrict it with the deployment network or trusted reverse-proxy/ingress policy. The endpoint does not reveal identities or payloads, but traffic and operation rates are operational information.

## Known boundaries

The standalone notification worker is a separate process and its existing structured logs report batch and delivery failures; the API's process-local metrics do not provide worker queue depth or delivery-lag metrics. Dedicated worker metrics and optional OpenTelemetry export are follow-up work rather than something this endpoint claims to cover. The project currently has no distributed tracing exporter and a trace ID is correlation metadata, not a complete trace/span.

For a production release, configure a metrics scraper, retention, dashboards, alert thresholds, log collection, and restricted network access in the actual deployment environment. The repository does not configure external alerting services or production infrastructure automatically.
