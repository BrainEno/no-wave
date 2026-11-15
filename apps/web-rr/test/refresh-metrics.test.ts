import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createRefreshMetricsHandler } from "../refresh/metrics-handler.ts";
import { RefreshTelemetry } from "../refresh/telemetry.ts";

const credential = "fixture-only-operations-credential-0123456789abcd";
test("refresh diagnostics are disabled by default and require a separate credential when enabled", async t => {
  let enabled = false;
  const disabled = createRefreshMetricsHandler({});
  const protectedHandler = createRefreshMetricsHandler({ WEB_REFRESH_METRICS_TOKEN: credential });
  const server = createServer((request, response) => { (enabled ? protectedHandler : disabled)(request, response, () => "web_refresh_requests_total 1\n"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string"); const url = `http://127.0.0.1:${address.port}/internal/refresh-metrics`;
  assert.equal((await fetch(url)).status, 404); enabled = true;
  assert.equal((await fetch(url)).status, 401);
  const auth = { authorization: `Bearer ${credential}` };
  const result = await fetch(url, { headers: auth }); assert.equal(result.status, 200); assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(await result.text(), "web_refresh_requests_total 1\n");
  assert.equal((await fetch(url + "?token=private-canary", { headers: auth })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers: auth })).status, 405);
  const head = await fetch(url, { method: "HEAD", headers: auth }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
});

test("refresh telemetry is bounded and cannot turn event labels into secret-bearing metrics", () => {
  const telemetry = new RefreshTelemetry();
  telemetry.observe({ event: "claimed" }); telemetry.observe({ event: "rejected", reason: "database" });
  const text = telemetry.render({ mode: "postgres", ready: false, pending: 2, callbacks: 1 });
  assert.match(text, /web_refresh_coordination_events_total\{event="claimed"\} 1/);
  assert.match(text, /web_refresh_coordination_failures_total\{reason="database"\} 1/);
  assert.match(text, /web_refresh_coordination_ready 0/);
  assert.doesNotMatch(text, /fixture-only|postgres:\/\/|generation_key/);
});

test("operations credentials cannot silently reuse encryption, JWT or provenance secrets", () => {
  for (const name of ["WEB_REFRESH_ENCRYPTION_KEY", "AUTH_JWT_SECRET", "BFF_CLIENT_ADDRESS_SECRET"]) {
    assert.throws(() => createRefreshMetricsHandler({ WEB_REFRESH_METRICS_TOKEN: credential, [name]: credential }),
      error => error instanceof Error && !error.message.includes(credential), name);
  }
});

test("authenticated metrics have a hard rate/output ceiling and sanitize renderer failures", async t => {
  let mode: "normal" | "large" | "throw" = "large";
  const handler = createRefreshMetricsHandler({ WEB_REFRESH_METRICS_TOKEN: credential });
  const server = createServer((request, response) => { handler(request, response, () => {
    if (mode === "throw") throw new Error("private-metrics-canary");
    return mode === "large" ? "private-metrics-canary".repeat(1000) : "web_refresh_coordination_ready 1\n";
  }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/internal/refresh-metrics`, headers = { authorization: `Bearer ${credential}` };
  for (const failure of ["large", "throw"] as const) {
    mode = failure; const result = await fetch(url, { headers }); assert.equal(result.status, 503); assert.equal(await result.text(), "Metrics unavailable");
  }
  mode = "normal";
  for (let remaining = 0; remaining < 58; remaining++) { const result = await fetch(url, { headers }); assert.equal(result.status, 200); await result.body?.cancel(); }
  const limited = await fetch(url, { headers }); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await fetch(url)).status, 401, "a saturated authenticated bucket must not expose metrics to an unauthenticated caller");
});

test("runtime pressure diagnostics distinguish waiter, real driver, circuit and notification saturation", () => {
  const text = new RefreshTelemetry().render({ mode: "postgres", ready: false, pending: 2, callbacks: 1, waiters: 19, waitingKeys: 6,
    database: { active: 3, queued: 2, circuit: "open", failures: 3, retryAfterMs: 1200, notificationKeys: 7, notificationWaiters: 4, notificationIgnored: 9 } });
  assert.match(text, /web_refresh_coordination_request_waiters 19/);
  assert.match(text, /web_refresh_coordination_database_active_operations 3/);
  assert.match(text, /web_refresh_coordination_database_queued_operations 2/);
  assert.match(text, /web_refresh_coordination_database_circuit\{state="open"\} 1/);
  assert.match(text, /web_refresh_coordination_database_retry_after_seconds 1.2/);
  assert.match(text, /web_refresh_coordination_notification_ignored_total 9/);
  assert.doesNotMatch(text, /fixture-only|postgres:\/\/|generation_key/);
});
