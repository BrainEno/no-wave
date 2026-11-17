import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamAdmission } from "../src/upstream-admission.ts";
import { UpstreamTelemetry } from "../src/upstream-telemetry.ts";
import { UpstreamTimeoutError } from "../src/api.ts";
import { UpstreamBusyError, UpstreamResponseError } from "../src/upstream-errors.ts";
import { json } from "./helpers.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("a success without any JSON bytes is rejected before export headers are exposed", async () => {
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(null, { headers: { "content-type": "application/json" } }) });
  await assert.rejects(transport.openStream("https://api.test/export"), UpstreamResponseError);
  assert.equal(await transport.close(), true);
});

test("bodyless HTTP statuses release bulk capacity without inventing a JSON payload", async () => {
  for (const status of [204, 205, 304]) {
    const transport = new UpstreamTransport({ fetchImpl: async () => new Response(null, { status }) });
    const response = await transport.openStream("https://api.test/export");
    assert.equal(response.status, status); assert.equal(response.body, null);
    await tick(); assert.equal(transport.snapshot().bulk.active, 0);
    assert.equal(await transport.close(), true);
  }
});

test("operational state reveals a timed-out physical probe without dynamic labels or a second retry", async () => {
  const telemetry = new UpstreamTelemetry();
  let now = 0;
  let calls = 0;
  let endProbe!: (response: Response) => void;
  const transport = new UpstreamTransport({ circuit: { threshold: 1, cooldownMs: 100, now: () => now },
    observer: sample => telemetry.observe(sample), fetchImpl: async () => {
      calls++;
      if (calls === 1) return json({ error: { code: "PRIVATE", message: "diagnostic canary" } }, 503);
      return new Promise<Response>(resolve => { endProbe = resolve; });
    } });
  await transport.request("https://api.test/private?token=canary");
  now = 100;
  await assert.rejects(transport.request("https://api.test/private", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
  assert.equal(transport.snapshot().data.active, 1);
  assert.equal(transport.snapshot().data.detached, 1);
  assert.equal(transport.snapshot().data.cancelling, 0, "the fetch has not supplied a body to cancel yet");
  now = 1000;
  await assert.rejects(transport.request("https://api.test/private"), UpstreamBusyError);
  const text = telemetry.render(transport.snapshot(), transport.circuitSnapshot());
  assert.match(text, /web_upstream_circuit_state\{lane="data",state="half-open"\} 1/);
  assert.match(text, /web_upstream_circuit_failures\{lane="data"\} 1/);
  assert.match(text, /web_upstream_oldest_active_seconds\{lane="data"\} 0\./);
  assert.match(text, /web_upstream_detached\{lane="data"\} 1/);
  assert.match(text, /web_upstream_cancelling\{lane="data"\} 0/);
  assert.match(text, /web_upstream_oldest_detached_seconds\{lane="data"\} 0\./);
  assert.doesNotMatch(text, /api\.test|private|canary|NaN|undefined/);
  assert.equal(calls, 2);
  endProbe(json({ data: true })); await tick();
  assert.equal(transport.snapshot().data.active, 0);
  const drained = telemetry.render(transport.snapshot(), transport.circuitSnapshot());
  assert.match(drained, /web_upstream_oldest_active_seconds\{lane="data"\} 0\n/);
  assert.equal(await transport.close(), true);
});

test("buffered JSON rejects an advertised non-JSON stream before pulling any content", async () => {
  let pulls = 0, cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    pull() { pulls++; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/html" } }) });
  await assert.rejects(transport.request("https://api.test", {}, { responseType: "json", timeoutMs: 50 }), UpstreamResponseError);
  assert.equal(pulls, 0); assert.equal(cancelled, true);
  assert.equal(await transport.close(), true);
});

test("active-age accounting survives repeated releases without accumulating request identities", async () => {
  const admission = new UpstreamAdmission();
  const first = await admission.acquire("data"); const second = await admission.acquire("data");
  await tick();
  assert.ok(admission.snapshot().data.oldestActiveMs >= 0);
  first.release(); first.release();
  assert.equal(admission.snapshot().data.active, 1);
  second.release();
  assert.equal(admission.snapshot().data.oldestActiveMs, 0);
});

test("queue pressure measures actual wait until grant, overflow or cancellation with one bounded sample each", async t => {
  const admission = new UpstreamAdmission({ concurrency: 1, queue: 1, queueTimeoutMs: 1000 });
  const first = await admission.acquire("data");
  const controller = new AbortController();
  const queued = admission.acquire("data", controller.signal);
  const cancelled = assert.rejects(queued, error => error instanceof Error && error.name === "UpstreamCancelledError");
  t.after(async () => { controller.abort(); first.release(); await cancelled; });
  await assert.rejects(admission.acquire("data"), UpstreamBusyError);
  assert.equal(admission.snapshot().data.wait.count, 2, "a still-waiting operation has no finished latency sample");
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort(); await cancelled;
  const beforeRelease = admission.snapshot().data.wait;
  assert.equal(beforeRelease.count, 3);
  assert.ok(beforeRelease.totalMs >= 5);
  first.release(); first.release();
  assert.deepEqual(admission.snapshot().data.wait, beforeRelease, "lease release must not sample admission a second time");
  const text = new UpstreamTelemetry().render(admission.snapshot());
  assert.match(text, /web_upstream_admission_wait_seconds_count\{lane="data"\} 3/);
  assert.match(text, /web_upstream_admission_wait_seconds_bucket\{lane="data",le="\+Inf"\} 3/);
  beforeRelease.buckets.fill(99);
  assert.notDeepEqual(admission.snapshot().data.wait.buckets, beforeRelease.buckets, "operational snapshots cannot mutate live counters");
});

test("failure samples preserve observed HTTP class and accepted decoded bytes without counting a refused chunk", async () => {
  const samples: import("../src/upstream-telemetry.ts").UpstreamSample[] = [];
  const transport = new UpstreamTransport({ observer: sample => samples.push(sample), fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([123, 32])); controller.enqueue(new Uint8Array(10)); controller.close(); },
  }), { status: 200 }) });
  await assert.rejects(transport.request("https://api.test", {}, { maxBytes: 3 }), UpstreamResponseError);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]!.outcome, "too_large");
  assert.equal(samples[0]!.bytes, 2);
  assert.equal(samples[0]!.status, 200);
  assert.equal(await transport.close(), true);
});
