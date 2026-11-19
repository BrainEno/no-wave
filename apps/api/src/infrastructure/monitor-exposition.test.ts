import assert from "node:assert/strict";
import test from "node:test";
import { createHttpObservability } from "./http-observability.ts";
import { createOutboxMetrics } from "../persistence/outbox-metrics.ts";
import { parseMonitorExposition } from "./monitor-exposition.ts";

const now = 1_800_000_000_000;
const gauge = (name: string, value: number) => `# TYPE ${name} gauge\n${name} ${value}\n`;
function apiMetrics() {
  const metrics = createHttpObservability({ logger() {} });
  const record = (route: string, statusCode: number) => {
    const observation = metrics.beginRequest({ method: "GET", url: "/", headers: {} } as never, { setHeader() {} } as never);
    observation.assignRoute(route);
    observation.finish({ statusCode, durationMs: 1 });
  };
  record("articles", 200); record("articles.item", 503); record("health", 503);
  metrics.observeMailDelivery({ purpose: "password_reset", outcome: "failed", durationMs: 1 });
  metrics.observeMailDelivery({ purpose: "email_verification", outcome: "skipped", durationMs: 1 });
  return metrics.renderMetrics() + gauge("api_readiness_available", 1) + gauge("api_persistence_available", 1) +
    gauge("api_notification_backlog_available", 1) + gauge("api_notification_pending_events", 2) +
    gauge("api_notification_dead_letter_events", 1) + gauge("api_notification_oldest_pending_age_seconds", 150) +
    gauge("api_notification_backlog_sample_timestamp_seconds", now / 1000);
}
function workerMetrics() {
  return createOutboxMetrics().render() + gauge("notification_worker_ready", 1) +
    gauge("notification_worker_backlog_available", 1) + gauge("notification_worker_backlog_sample_age_seconds", 1) +
    gauge("notification_worker_backlog_sample_timestamp_seconds", now / 1000 - 1) +
    gauge("notification_worker_backlog_oldest_pending_age_seconds", 0) + gauge("notification_worker_backlog_freshness_budget_seconds", 10);
}
const invalid = (text: string, role: "api" | "notification-worker" = "api") => assert.throws(() => parseMonitorExposition(text, role, now, 90_000), { code: "invalid_metrics" });

test("real API exposition becomes bounded numeric facts without routes, identities or source text", () => {
  const snapshot = parseMonitorExposition(apiMetrics(), "api", now, 90_000);
  assert.deepEqual(snapshot.http, { requests: 2, errors: 1 }, "health and monitoring traffic cannot cause or dilute a product 5xx alert");
  assert.equal(snapshot.mailFailures, 1, "skipped mail is not a failed delivery or a denominator");
  assert.deepEqual(snapshot.backlog, { pending: 2, deadLetters: 1, oldestAgeSeconds: 150 });
  assert.equal(snapshot.databaseAvailable, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /articles|password_reset|email_verification|route/);
});

test("one worker's monotonic freshness gates all last-known backlog gauges", () => {
  assert.deepEqual(parseMonitorExposition(workerMetrics(), "notification-worker", now, 90_000).backlog, { pending: 0, deadLetters: 0, oldestAgeSeconds: 0 });
  const stale = workerMetrics().replace("notification_worker_backlog_sample_age_seconds 1", "notification_worker_backlog_sample_age_seconds 11");
  const snapshot = parseMonitorExposition(stale, "notification-worker", now, 90_000);
  assert.equal(snapshot.backlog, null, "stale zero is not proof that the durable queue is empty");
  assert.equal(snapshot.http, null);
  assert.equal(snapshot.databaseAvailable, null);
});

test("missing, unavailable or future backlog samples never become healthy zeros", () => {
  for (const text of [apiMetrics().replace("api_notification_backlog_available 1", "api_notification_backlog_available 0"), apiMetrics().replace(`api_notification_backlog_sample_timestamp_seconds ${now / 1000}`, "api_notification_backlog_sample_timestamp_seconds 1"), apiMetrics().replace(`api_notification_backlog_sample_timestamp_seconds ${now / 1000}`, `api_notification_backlog_sample_timestamp_seconds ${now / 1000 + 31}`)]) {
    assert.equal(parseMonitorExposition(text, "api", now, 90_000).backlog, null);
  }
  invalid(apiMetrics().replace(/# TYPE api_persistence_available gauge\napi_persistence_available 1\n/, ""));
  invalid(workerMetrics());
  invalid(apiMetrics(), "notification-worker");
});

test("ambiguous types, duplicate series and unbounded/unsafe metric values fail closed", () => {
  invalid(apiMetrics() + gauge("api_persistence_available", 1));
  invalid(apiMetrics().replace("# TYPE api_http_requests_total counter", "# TYPE api_http_requests_total gauge"));
  invalid(apiMetrics().replace("api_persistence_available 1", "api_persistence_available NaN"));
  invalid(apiMetrics().replace("api_persistence_available 1", "api_persistence_available 1 123"));
  invalid(apiMetrics().replace("api_notification_pending_events 2", "api_notification_pending_events 0.5"));
  invalid(apiMetrics().replace("api_notification_pending_events 2", "api_notification_pending_events -1"));
  invalid(apiMetrics().replace("api_notification_pending_events 2", "api_notification_pending_events 0"));
  invalid(apiMetrics().replace('method="GET",route="articles",status="200"} 1', 'status="200",route="articles",method="GET"} 1') + 'api_http_requests_total{method="GET",route="articles",status="200"} 2\n');
  invalid(apiMetrics().replace('method="GET",route="articles",status="200"', 'method="GET",method="POST",route="articles",status="200"'));
  invalid(apiMetrics().replace('route="articles"', 'route="private/user@example.test"'));
  invalid(apiMetrics().replace('outcome="failed"', 'outcome="invented"'));
  invalid(apiMetrics() + "# " + "x".repeat(8193));
});

test("family declarations distinguish no attempted mail from an omitted or truncated counter", () => {
  const quiet = apiMetrics().replace(/^api_identity_mail_deliveries_total\{[^\n]*\n/gm, "");
  assert.equal(parseMonitorExposition(quiet, "api", now, 90_000).mailFailures, 0);
  invalid(quiet.replace("# TYPE api_identity_mail_deliveries_total counter\n", ""));
  invalid(apiMetrics().replace('status="503"} 1', 'status="503"} 9007199254740992'));
});
