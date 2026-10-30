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
