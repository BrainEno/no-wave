import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseMonitorConfig } from "./monitor-config.ts";
import { collectMonitorTargets } from "./monitor-scrape.ts";
import { MONITOR_SCRAPE_MAX_BYTES } from "./monitor-exposition.ts";
import { createOutboxMetrics } from "../persistence/outbox-metrics.ts";

const headers = { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" };
const gauge = (name: string, value: number) => `# TYPE ${name} gauge\n${name} ${value}\n`;
function body() {
  return createOutboxMetrics().render() + gauge("notification_worker_ready", 1) + gauge("notification_worker_backlog_available", 1) +
    gauge("notification_worker_backlog_sample_age_seconds", 0) + gauge("notification_worker_backlog_sample_timestamp_seconds", Date.now() / 1000) +
    gauge("notification_worker_backlog_oldest_pending_age_seconds", 0) + gauge("notification_worker_backlog_freshness_budget_seconds", 10);
}
async function serve(t: Parameters<Parameters<typeof test>[1]>[0], handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/metrics`;
}
function config(urls: string[], extra: Record<string, unknown> = {}) {
  return parseMonitorConfig({ version: 1, targets: urls.map((metricsUrl, i) => ({ id: `worker-${i}`, role: "notification-worker", metricsUrl })), scrapeTimeoutMs: 500, runTimeoutMs: 2000, ...extra });
}

test("a monitor reads only configured GET metrics and returns facts, never source headers or text", async t => {
  const url = await serve(t, (request, response) => {
    assert.equal(request.method, "GET"); assert.equal(request.url, "/metrics");
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    response.writeHead(200, { ...headers, "x-private-canary": "never-copy-this" }); response.end(body());
  });
  const result = await collectMonitorTargets(config([url]));
  assert.equal(result[0].reason, "ok");
  assert.equal(result[0].snapshot?.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /never-copy-this|127\.0\.0\.1|\/metrics|HELP|TYPE/);
});

test("redirects and wrong content contracts are not followed or interpreted as readiness", async t => {
  let privateHits = 0;
  const privateUrl = await serve(t, (_request, response) => { privateHits++; response.end(body()); });
  const redirect = await serve(t, (_request, response) => { response.writeHead(302, { location: privateUrl }); response.end("private-source-canary"); });
  const json = await serve(t, (_request, response) => { response.writeHead(200, { ...headers, "content-type": "application/json" }); response.end('{"secret":"private-source-canary"}'); });
  const zipped = await serve(t, (_request, response) => { response.writeHead(200, { ...headers, "content-encoding": "gzip" }); response.end("private-source-canary"); });
  const result = await collectMonitorTargets(config([redirect, json, zipped]));
  assert.deepEqual(result.map(row => row.reason), ["http_status", "invalid_content_type", "invalid_content_type"]);
  assert.equal(privateHits, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-source-canary/);
});

test("content-type parameter quotes must be balanced, not just contain the expected number", async t => {
  const urls: string[] = [];
  for (const type of ['text/plain; version="0.0.4', 'text/plain; charset=utf-8"', 'text/plain; version="0.0.4"; charset="utf-8"']) {
    urls.push(await serve(t, (_request, response) => { response.writeHead(200, { ...headers, "content-type": type }); response.end(body()); }));
  }
  const result = await collectMonitorTargets(config(urls));
  assert.deepEqual(result.map(row => row.reason), ["invalid_content_type", "invalid_content_type", "ok"]);
});

test("cached responses and invalid UTF-8 cannot provide a fresh successful observation", async t => {
  const cached = await serve(t, (_request, response) => { response.writeHead(200, { ...headers, age: "1" }); response.end(body()); });
  const cacheable = await serve(t, (_request, response) => { response.writeHead(200, { "content-type": headers["content-type"] }); response.end(body()); });
  const corrupt = await serve(t, (_request, response) => { response.writeHead(200, headers); response.end(Buffer.from([0xc3, 0x28])); });
  const result = await collectMonitorTargets(config([cached, cacheable, corrupt]));
  assert.deepEqual(result.map(row => row.reason), ["stale_response", "stale_response", "invalid_metrics"]);
});

test("both declared and actually received bytes are bounded before parsing", async t => {
  const declared = await serve(t, (_request, response) => { response.writeHead(200, { ...headers, "content-length": String(MONITOR_SCRAPE_MAX_BYTES + 1) }); response.flushHeaders(); });
  const chunked = await serve(t, (_request, response) => { response.writeHead(200, headers); response.end(Buffer.alloc(MONITOR_SCRAPE_MAX_BYTES + 1, 120)); });
  const result = await collectMonitorTargets(config([declared, chunked]));
  assert.deepEqual(result.map(row => row.reason), ["response_too_large", "response_too_large"]);
});

test("the deadline covers response bodies and releases actual client requests, not just waiters", async t => {
  let closed = 0;
  const url = await serve(t, (_request, response) => {
    response.once("close", () => { closed++; });
    response.writeHead(200, headers); response.write("# stalled-body\n");
  });
  const at = performance.now();
  const result = await collectMonitorTargets(config([url], { scrapeTimeoutMs: 60, runTimeoutMs: 200 }));
  assert.equal(result[0].reason, "timeout");
  assert.ok(performance.now() - at < 1500);
  await delay(10);
  assert.equal(closed, 1);
});

test("at most four requests own physical capacity and an overall deadline also bounds queued targets", async t => {
  let active = 0, maximum = 0, attempted = 0;
  const urls: string[] = [];
  for (let i = 0; i < 8; i++) urls.push(await serve(t, (_request, response) => {
    active++; attempted++; maximum = Math.max(maximum, active);
    response.once("close", () => { active--; }); response.writeHead(200, headers); response.write("# stalled\n");
  }));
  const result = await collectMonitorTargets(config(urls, { scrapeTimeoutMs: 100, runTimeoutMs: 100 }));
  assert.ok(maximum <= 4); assert.ok(attempted <= 4);
  assert.equal(result.length, 8);
  assert.ok(result.every(row => row.reason === "timeout" || row.reason === "run_timeout"));
  assert.ok(result.some(row => row.reason === "run_timeout"));
  await delay(10); assert.equal(active, 0);
});

test("cancellation aborts active sockets and does not start a second wave", async t => {
  const controller = new AbortController();
  let hits = 0, active = 0;
  const urls: string[] = [];
  for (let i = 0; i < 6; i++) urls.push(await serve(t, (_request, response) => {
    hits++; active++; response.once("close", () => { active--; });
    response.writeHead(200, headers); response.write("# wait\n");
    if (hits === 4) controller.abort();
  }));
  await assert.rejects(collectMonitorTargets(config(urls), controller.signal), { code: "cancelled" });
  await delay(10); assert.equal(active, 0); assert.equal(hits, 4);
  await assert.rejects(collectMonitorTargets(config(urls), AbortSignal.abort()), { code: "cancelled" });
  assert.equal(hits, 4);
});
