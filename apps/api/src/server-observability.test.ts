/** Correlation IDs, access logs, metrics and unmatched API paths. Split from server.test.ts (#357). */
import assert from "node:assert/strict";
import test from "node:test";
import { authEnv, withServer } from "./test-support/rest-server-harness.ts";




test("HTTP requests include a correlation ID and logs exclude URL, query, and credential values", async () => {
  const logs = [];
  const secret = "sensitive-token-value";
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/graphql/private-path?access_token=" + secret, {
      headers: {
        authorization: "Bearer " + secret,
        cookie: "session=" + secret,
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
    await response.text();
  }, { logger: (record) => logs.push(record) });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "http_request_completed");
  assert.equal(logs[0].traceId, "0123456789abcdef0123456789abcdef");
  assert.equal(logs[0].route, "/not_found");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private-path"), false);
  assert.equal(serialized.includes("access_token"), false);
});

test("the access log names the endpoint that answered, and quiet probes stay out of it", async () => {
  const logs = [];
  await withServer(async (baseUrl) => {
    // A matched route: the log says which one, not `/api/v1/*`.
    const tags = await fetch(baseUrl + "/api/v1/tags?locale=zh-CN");
    assert.equal(tags.status, 200);
    await tags.text();

    // A successful liveness probe: counted in metrics, absent from the log. This
    // is the line a host — or a client stuck in a retry loop — would otherwise
    // write a quarter of a million times an hour.
    const probe = await fetch(baseUrl + "/api/v1/health");
    assert.equal(probe.status, 200);
    await probe.text();
  }, {
    logger: (record) => logs.push(record),
    store: { async isSessionRevoked() { return false; } },
  });

  const completed = logs.filter((record) => record.event === "http_request_completed");
  assert.deepEqual(completed.map((record) => record.route), ["tags"], "only the real request is logged, under its route id");
  assert.equal(JSON.stringify(logs).includes("zh-CN"), false, "the query string never reaches the log");
});

test("an unmatched API path is still labelled as the API, not as a route", async () => {
  const logs = [];
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/api/v1/no-such-endpoint");
    assert.equal(response.status, 404);
    await response.text();
  }, { logger: (record) => logs.push(record) });

  assert.equal(logs[0].route, "/api/v1/*", "there is no route id to name, and the path must not become the label");
  assert.equal(logs[0].statusCode, 404);
});

test("Prometheus metrics endpoint exposes bounded HTTP and authentication metrics", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(baseUrl + "/health");
    await health.text();

    const unauthenticated = await fetch(baseUrl + "/api/v1/me/profile?secret=not-for-metrics");
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();

    const response = await fetch(baseUrl + "/metrics");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain.*version=0\.0\.4/i);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const metrics = await response.text();
    assert.match(metrics, /api_http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
    assert.match(metrics, /api_http_request_duration_ms_bucket/);
    assert.match(metrics, /api_http_auth_failures_total\{method="GET",status="401"\} 1/);
    assert.match(metrics, /api_http_active_requests 1|api_http_active_requests 0/);
    assert.equal(metrics.includes("not-for-metrics"), false);
    assert.equal(metrics.includes("secret="), false);
  }, {
    env: { ...authEnv, API_METRICS_ENABLED: "true" },
    store: { async isSessionRevoked() { return false; } },
  });
});

test("metrics endpoint is disabled by default to avoid public operational-data exposure", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(baseUrl + "/metrics");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "NOT_FOUND", message: "The requested route was not found." },
    });
  });
});
