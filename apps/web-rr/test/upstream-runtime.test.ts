import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createUpstreamMetricsHandler } from "../upstream/metrics-handler.ts";
import { startProductionWeb } from "./support/production-web.ts";

const credential = "fixture-upstream-operations-token-0123456789abcdef";
const operationsHeaders = { authorization: `Bearer ${credential}` };

async function fixture(t: test.TestContext, env: Record<string, string> = {}) {
  let hold: (() => void) | undefined;
  let upstreamClosed: Promise<unknown> | undefined;
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/v1/me/articles")) {
      upstreamClosed = once(response, "close");
      hold = () => response.end('{"data":[]}');
    } else if (request.url === "/api/v1/me") response.end('{"data":{"id":"fixture-reader","displayName":"Fixture"}}');
    else if (request.url?.startsWith("/api/v1/tags")) response.end('{"data":[]}');
    else response.end('{"data":[]}');
  });
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  t.after(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()); }));
  const address = api.address(); assert.ok(address && typeof address !== "string");
  const web = await startProductionWeb({ API_BASE_URL: `http://127.0.0.1:${address.port}`, WEB_UPSTREAM_METRICS_TOKEN: credential,
    WEB_UPSTREAM_CONCURRENCY: "1", WEB_UPSTREAM_QUEUE: "0", ...env });
  t.after(() => web.close());
  const started = async () => {
    const deadline = Date.now() + 5000;
    while (!hold && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(hold, "the first resource must physically reach the API");
  };
  return { ...web, started, finish: () => hold?.(), closed: () => upstreamClosed! };
}

test("production SSR and BFF share native telemetry, admission errors and the reserved identity lane", { timeout: 20_000 }, async t => {
  const web = await fixture(t);
  assert.equal((await fetch(`${web.origin}/internal/upstream-metrics`)).status, 401);
  const publicRead = await fetch(`${web.origin}/tags`); assert.equal(publicRead.status, 200); await publicRead.text();
  const first = fetch(`${web.origin}/api/authoring/articles`);
  await web.started();
  const busy = await fetch(`${web.origin}/api/authoring/articles`);
  assert.equal(busy.status, 503); assert.equal(busy.headers.get("retry-after"), "1");
  assert.equal((await busy.json()).error.code, "UPSTREAM_BUSY");
  const session = await fetch(`${web.origin}/api/authoring/session`, { headers: { cookie: "nw_access=fixture-access" } });
  assert.equal(session.status, 200); assert.equal((await session.json()).data.id, "fixture-reader");
  const diagnostic = await fetch(`${web.origin}/internal/upstream-metrics`, { headers: operationsHeaders });
  assert.equal(diagnostic.status, 200);
  const text = await diagnostic.text();
  assert.match(text, /web_upstream_requests_total\{kind="content",outcome="ok"\} [1-9]/);
  assert.match(text, /web_upstream_requests_total\{kind="api",outcome="capacity"\} 1/);
  assert.match(text, /web_upstream_requests_total\{kind="auth",outcome="ok"\} 1/);
  assert.match(text, /web_upstream_active\{lane="data"\} 1/);
  assert.match(text, /web_intake_active\{lane="ordinary"\} 1/);
  assert.match(text, /web_upstream_circuit_state\{lane="data",state="closed"\} 1/);
  assert.ok(Buffer.byteLength(text) < 32_768);
  assert.doesNotMatch(text, /fixture-access|fixture-reader|api\/v1|127\.0\.0\.1/);
  web.finish(); assert.equal((await first).status, 200);
});

test("a real browser disconnect cancels its pending upstream and returns its physical capacity", { timeout: 20_000 }, async t => {
  const web = await fixture(t);
  const controller = new AbortController();
  const pending = fetch(`${web.origin}/api/authoring/articles`, { signal: controller.signal });
  const cancelled = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  await web.started(); controller.abort(); await cancelled;
  await Promise.race([web.closed(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The upstream socket survived browser cancellation.")), 2000).unref())]);
  const text = await (await fetch(`${web.origin}/internal/upstream-metrics`, { headers: operationsHeaders })).text();
  assert.match(text, /web_upstream_requests_total\{kind="api",outcome="cancelled"\} 1/);
  assert.match(text, /web_upstream_active\{lane="data"\} 0/);
});

test("upstream operations credentials are independent of every other server secret", () => {
  for (const name of ["WEB_REFRESH_METRICS_TOKEN", "WEB_REFRESH_ENCRYPTION_KEY", "AUTH_JWT_SECRET", "BFF_CLIENT_ADDRESS_SECRET"]) {
    assert.throws(() => createUpstreamMetricsHandler({ WEB_UPSTREAM_METRICS_TOKEN: credential, [name]: credential }),
      error => error instanceof Error && !error.message.includes(credential));
  }
});
