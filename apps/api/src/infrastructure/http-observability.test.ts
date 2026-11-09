import assert from "node:assert/strict";
import test from "node:test";
import { createHttpObservability } from "./http-observability.ts";
import { createPersistencePorts } from "../application/persistence-ports.ts";

function fakeResponse() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
  };
}

function fakeRequest({ method = "GET", url = "/", headers = {} } = {}) {
  return { method, url, headers };
}

test("HTTP observations use a generated request ID and a validated upstream trace ID", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });
  const response = fakeResponse();
  const request = fakeRequest({
    method: "GET",
    url: "/api/v1/articles/private-id?token=must-not-log",
    headers: {
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      authorization: "Bearer never-log-this",
      cookie: "session=never-log-this",
    },
  });
  const observation = observability.beginRequest(request, response);
  observation.finish({ statusCode: 200, durationMs: 13.125 });

  const log = logs[0];
  assert.equal(response.headers.get("x-request-id"), observation.requestId);
  assert.match(observation.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(observation.traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(log.event, "http_request_completed");
  assert.equal(log.requestId, observation.requestId);
  assert.equal(log.traceId, observation.traceId);
  assert.equal(log.route, "/api/v1/*", "resource IDs and query values must not become labels");
  assert.equal(log.durationMs, 13.125);
  assert.equal(JSON.stringify(logs).includes("never-log-this"), false);
  assert.equal(JSON.stringify(logs).includes("private-id"), false);
  assert.equal(JSON.stringify(logs).includes("token="), false);
});

test("a matched route names itself in the log and the metrics, and only a bounded id is accepted", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });

  const observation = observability.beginRequest(
    fakeRequest({ method: "GET", url: "/api/v1/articles/private-id/comments?locale=zh-CN" }),
    fakeResponse(),
  );
  observation.assignRoute("articles.comments");
  observation.finish({ statusCode: 200, durationMs: 4 });

  assert.equal(logs[0].route, "articles.comments", "the endpoint, not the path and not the resource id");
  assert.equal(JSON.stringify(logs).includes("private-id"), false);

  // A handler — or a URL — cannot invent a label, and a label is set once.
  const hostile = observability.beginRequest(fakeRequest({ url: "/api/v1/articles" }), fakeResponse());
  hostile.assignRoute("../../etc/passwd");
  hostile.assignRoute("articles");
  hostile.assignRoute("articles.item");
  hostile.finish({ statusCode: 200, durationMs: 1 });
  assert.equal(logs[1].route, "articles", "the first bounded assignment wins; the path-shaped one was ignored");

  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_http_requests_total\{method="GET",route="articles.comments",status="200"\} 1/);
});

test("a successful probe is counted but not logged, and a failing one is logged", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });

  const healthy = observability.beginRequest(fakeRequest({ url: "/api/v1/health" }), fakeResponse());
  healthy.assignRoute("health");
  healthy.finish({ statusCode: 200, durationMs: 0.2 });
  assert.deepEqual(logs, [], "a liveness probe every second must not be the loudest line in the terminal");

  const degraded = observability.beginRequest(fakeRequest({ url: "/api/v1/health" }), fakeResponse());
  degraded.assignRoute("health");
  degraded.finish({ statusCode: 503, durationMs: 1.4 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].statusCode, 503, "the probe that fails is the one an operator has to see");

  // Still counted: the metrics are where a probe belongs.
  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_http_requests_total\{method="GET",route="health",status="200"\} 1/);
  assert.match(metrics, /api_http_requests_total\{method="GET",route="health",status="503"\} 1/);
});

test("a client polling one route in a loop produces one warning, not one line per request", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });

  // 300 liveness probes inside one second: a client with no interval.
  for (let index = 0; index < 300; index += 1) {
    const observation = observability.beginRequest(fakeRequest({ url: "/api/v1/health" }), fakeResponse());
    observation.assignRoute("health");
    observation.finish({ statusCode: 200, durationMs: 0.16 });
  }

  const warnings = logs.filter((record) => record.event === "http_request_flood");
  assert.equal(warnings.length, 1, "one line says it; the other 299 requests are noise");
  assert.equal(warnings[0].level, "warn");
  assert.equal(warnings[0].route, "health");
  assert.ok(warnings[0].requestsPerSecond >= 200);
  assert.equal(logs.filter((record) => record.event === "http_request_completed").length, 0, "successful probes stay out of the log");

  // The quieter-window rule: another burst immediately afterwards does not repeat it.
  for (let index = 0; index < 300; index += 1) {
    const observation = observability.beginRequest(fakeRequest({ url: "/api/v1/health" }), fakeResponse());
    observation.assignRoute("health");
    observation.finish({ statusCode: 200, durationMs: 0.16 });
  }
  assert.equal(logs.filter((record) => record.event === "http_request_flood").length, 1);

  // And a normal page load never triggers it.
  const single = observability.beginRequest(fakeRequest({ url: "/api/v1/tags" }), fakeResponse());
  single.assignRoute("tags");
  single.finish({ statusCode: 200, durationMs: 2 });
  assert.equal(logs.filter((record) => record.event === "http_request_flood").length, 1);
});

test("invalid trace context is ignored and a new trace ID is generated", () => {
  const observability = createHttpObservability({ logger: () => {} });
  const observation = observability.beginRequest(
    fakeRequest({ headers: { traceparent: "malformed", "x-request-id": "attacker-controlled" } }),
    fakeResponse(),
  );
  assert.match(observation.traceId, /^[0-9a-f]{32}$/);
  assert.notEqual(observation.traceId, "attacker-controlled");
  observation.finish({ statusCode: 404, durationMs: 1 });
});

test("metrics expose request counters, latency histograms, auth failures, and bounded labels", () => {
  const observability = createHttpObservability({ logger: () => {} });
  const request = (method, url, statusCode, durationMs) => {
    const observation = observability.beginRequest(fakeRequest({ method, url }), fakeResponse());
    observation.finish({ statusCode, durationMs });
  };
  request("GET", "/health", 200, 2);
  request("GET", "/api/v1/articles/one?secret=alpha", 401, 17);
  request("POST", "/api/v1/articles/two", 403, 51);
  request("GET", "/missing/secret-path", 404, 7);

  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
  assert.match(metrics, /api_http_request_duration_ms_bucket\{method="GET",route="\/health",status="200",le="5"\} 1/);
  assert.match(metrics, /api_http_auth_failures_total\{method="GET",status="401"\} 1/);
  assert.match(metrics, /api_http_auth_failures_total\{method="POST",status="403"\} 1/);
  assert.match(metrics, /api_http_active_requests 0/);
  assert.equal(metrics.includes("secret-path"), false);
  assert.equal(metrics.includes("secret=alpha"), false);
});

test("metrics expose persistence-operation counts and duration histograms without data values", () => {
  const observability = createHttpObservability({ logger: () => {} });
  observability.observePersistenceOperation({ operation: "getAuthorProfile", durationMs: 12, success: true });
  observability.observePersistenceOperation({ operation: "getAuthorProfile", durationMs: 22, success: true });
  observability.observePersistenceOperation({ operation: "persistMessage", durationMs: 105, success: false });
  observability.observePersistenceOperation({ operation: 'bad"label', durationMs: 1, success: false });

  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_persistence_operations_total\{operation="getAuthorProfile",outcome="success"\} 2/);
  assert.match(metrics, /api_persistence_operation_duration_ms_bucket\{operation="getAuthorProfile",outcome="success",le="25"\} 2/);
  assert.match(metrics, /api_persistence_operations_total\{operation="persistMessage",outcome="error"\} 1/);
  assert.match(metrics, /operation="other"/);
  assert.equal(metrics.includes('bad"label'), false);
});

test("duplicate completion callbacks do not double count requests or decrement active gauge", () => {
  const observability = createHttpObservability({ logger: () => {} });
  const observation = observability.beginRequest(fakeRequest(), fakeResponse());
  observation.finish({ statusCode: 200, durationMs: 1 });
  observation.finish({ statusCode: 500, durationMs: 999 });
  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_http_requests_total\{method="GET",route="\/not_found",status="200"\} 1/);
  assert.equal(metrics.includes('status="500"'), false);
  assert.match(metrics, /api_http_active_requests 0/);
});


test("persistence port instrumentation measures async success and failure without logging payloads", async () => {
  const observability = createHttpObservability({ logger: () => {} });
  const ports = createPersistencePorts({
    async getAuthorProfile() { return { userId: "private-user", displayName: "Private" }; },
    async persistMessage() { throw new Error("private message body and database details"); },
  }, {
    onOperation: (sample) => observability.observePersistenceOperation(sample),
  });

  await ports.profiles.getAuthorProfile({ userId: "private-user" });
  await assert.rejects(ports.conversations.persistMessage({ body: "private message body" }), /private message body/);

  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_persistence_operations_total\{operation="getAuthorProfile",outcome="success"\} 1/);
  assert.match(metrics, /api_persistence_operations_total\{operation="persistMessage",outcome="error"\} 1/);
  assert.match(metrics, /api_persistence_operation_duration_ms_count\{operation="getAuthorProfile",outcome="success"\} 1/);
  assert.equal(metrics.includes("private-user"), false);
  assert.equal(metrics.includes("private message body"), false);
  assert.equal(metrics.includes("database details"), false);
});

/**
 * Account-mail observations.
 *
 * The recovery request answers `202` whether or not the mail went out, so these
 * counters are the only signal an operator has that recovery is broken — and the
 * only place an alert can rule on.
 */

test("a failed delivery is counted, logged at error level, and carries no address", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });
  observability.observeMailDelivery({
    purpose: "password_reset",
    outcome: "failed",
    durationMs: 12.5,
    code: "CONNECT",
    message: "connect ECONNREFUSED 127.0.0.1:2525",
  });

  const log = logs.at(-1);
  assert.equal(log.level, "error");
  assert.equal(log.event, "identity_mail_failed");
  assert.equal(log.purpose, "password_reset");
  assert.equal(log.code, "CONNECT");
  assert.equal(JSON.stringify(log).includes("writer@example.test"), false);

  const rendered = observability.renderMetrics();
  assert.match(rendered, /api_identity_mail_deliveries_total\{purpose="password_reset",outcome="failed"\} 1/);
  assert.match(rendered, /api_identity_mail_delivery_duration_ms_count\{purpose="password_reset",outcome="failed"\} 1/);
});

test("a delivered mail is counted as sent and stays out of the error stream", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });
  observability.observeMailDelivery({ purpose: "email_verification", outcome: "sent", durationMs: 240 });

  assert.equal(logs.at(-1).level, "info");
  assert.equal(logs.at(-1).event, "identity_mail_delivered");
  assert.match(
    observability.renderMetrics(),
    /api_identity_mail_deliveries_total\{purpose="email_verification",outcome="sent"\} 1/,
  );
});

test("a purpose outside the closed set cannot become an unbounded label", () => {
  const observability = createHttpObservability({ logger: () => {} });
  observability.observeMailDelivery({ purpose: "writer@example.test", outcome: "weird", durationMs: 1 });
  const rendered = observability.renderMetrics();
  assert.match(rendered, /purpose="other"/);
  assert.equal(rendered.includes("writer@example.test"), false, "a request-derived string must never become a label");
});

test("a failure message is truncated rather than relayed whole", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });
  observability.observeMailDelivery({ purpose: "password_reset", outcome: "failed", durationMs: 1, message: "x".repeat(5000) });
  assert.equal(String(logs.at(-1).message).length, 240);
});

/**
 * Audit F-22: the cleanup sweeps run outside any request, so a failure has no
 * status code to appear in. Without this counter a purge that stopped working is
 * indistinguishable from a recycle bin that is always empty.
 */
test("a failed background task is counted, logged as a warning, and carries the class only", () => {
  const logs = [];
  const observability = createHttpObservability({ logger: (record) => logs.push(record) });
  observability.observeBackgroundFailure({ task: "tombstone-purge", errorName: "RangeError" });
  observability.observeBackgroundFailure({ task: "tombstone-notifications", errorName: "Error", failed: 3 });

  const first = logs.at(-2);
  assert.equal(first.level, "warn");
  assert.equal(first.event, "background_task_failed");
  assert.equal(first.task, "tombstone-purge");
  assert.equal(first.errorName, "RangeError");
  assert.equal("failed" in first, false, "a one-off task counts nothing");

  const second = logs.at(-1);
  assert.equal(second.task, "tombstone-notifications");
  assert.equal(second.failed, 3, "the count of undeliverable notices is the useful part");

  const rendered = observability.renderMetrics();
  assert.match(rendered, /api_background_task_failures_total\{task="tombstone-purge"\} 1/);
  assert.match(rendered, /api_background_task_failures_total\{task="tombstone-notifications"\} 1/);
});

test("an unknown task name collapses to one label instead of growing the counter", () => {
  const observability = createHttpObservability({ logger: () => {} });
  // `errorName` is attacker-adjacent text in the worst case; neither it nor an
  // unrecognised task may become a label of its own.
  observability.observeBackgroundFailure({ task: "some-new-task" as never, errorName: "not a class name" });
  const rendered = observability.renderMetrics();
  assert.match(rendered, /api_background_task_failures_total\{task="other"\} 1/);
  assert.equal(rendered.includes("some-new-task"), false);
  assert.equal(rendered.includes("not a class name"), false);
});
