import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamBusyError, UpstreamCancelledError, UpstreamResponseError } from "../src/upstream-errors.ts";
import { UpstreamTimeoutError, withUpstreamDeadline } from "../src/api.ts";
import { UpstreamTelemetry, type UpstreamSample } from "../src/upstream-telemetry.ts";
import { UpstreamAdmission } from "../src/upstream-admission.ts";
import { bufferUpstreamResponse, upstreamJsonPayload } from "../src/upstream-response.ts";
import { json } from "./helpers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("finite FIFO admission rejects overflow and cancellation removes only its own waiter", async () => {
  const admission = new UpstreamAdmission({ concurrency: 1, queue: 2, queueTimeoutMs: 1000 });
  const first = await admission.acquire("data");
  const controller = new AbortController();
  const second = admission.acquire("data", controller.signal);
  const third = admission.acquire("data");
  await assert.rejects(admission.acquire("data"), error => error instanceof UpstreamBusyError && error.reason === "capacity");
  controller.abort();
  await assert.rejects(second, UpstreamCancelledError);
  assert.equal(admission.snapshot().data.queued, 1);
  first.release(); first.release();
  const last = await third;
  assert.equal(admission.snapshot().data.active, 1);
  last.release();
  assert.equal(admission.snapshot().data.active, 0);
});

test("queue expiry is bounded and cannot grant a lease later", async () => {
  const admission = new UpstreamAdmission({ concurrency: 1, queue: 1, queueTimeoutMs: 10 });
  const lease = await admission.acquire("data");
  await assert.rejects(admission.acquire("data"), error => error instanceof UpstreamBusyError && error.reason === "queue-timeout");
  assert.equal(admission.snapshot().data.queued, 0);
  lease.release();
  assert.equal(await admission.waitForIdle(10), true);
});

test("saturated public reads do not consume authentication or bulk slots", async () => {
  const admission = new UpstreamAdmission({ concurrency: 1, queue: 0, queueTimeoutMs: 20 });
  const data = await admission.acquire("data");
  const auth = await admission.acquire("auth");
  const bulk = await admission.acquire("bulk");
  assert.equal(admission.active(), 3);
  admission.stop();
  await assert.rejects(admission.acquire("auth"), UpstreamBusyError);
  assert.equal(await admission.waitForIdle(5), false);
  data.release(); auth.release(); bulk.release();
  assert.equal(await admission.waitForIdle(5), true);
});

test("timeouts retain physical slots until an abort-ignoring transport actually settles", async () => {
  const response = deferred<Response>();
  const samples: UpstreamSample[] = [];
  const transport = new UpstreamTransport({ fetchImpl: () => response.promise,
    admission: { concurrency: 1, queue: 0, queueTimeoutMs: 20 }, observer: sample => samples.push(sample) });
  await assert.rejects(transport.request("https://internal.test/token?secret=never-log", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
  assert.equal(transport.snapshot().data.active, 1);
  await assert.rejects(transport.request("https://internal.test"), UpstreamBusyError);
  let cancelled = false;
  response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await tick();
  assert.equal(cancelled, true);
  assert.equal(transport.snapshot().data.active, 0);
  assert.equal(samples.length, 2, "late completion must not produce a second success sample");
  assert.deepEqual(samples.map(sample => sample.outcome), ["timeout", "capacity"]);
  assert.doesNotMatch(JSON.stringify(samples), /internal|token|secret/);
  assert.equal(await transport.close(), true);
});

test("a stalled body is cancelled and releases its lease at the deadline", async () => {
  let cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  await assert.rejects(transport.request("https://internal.test", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
  await tick();
  assert.equal(cancelled, true);
  assert.equal(transport.snapshot().data.active, 0);
  assert.equal(await transport.close(), true);
});

test("shutdown rejects queued work, aborts active work, and is idempotent", async () => {
  const transport = new UpstreamTransport({ admission: { concurrency: 1, queue: 1, queueTimeoutMs: 1000 }, fetchImpl: async (_url, init) => {
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("private diagnostic")), { once: true }));
  } });
  const first = transport.request("https://internal.test");
  const second = transport.request("https://internal.test");
  const checkedFirst = assert.rejects(first, UpstreamCancelledError);
  const checkedSecond = assert.rejects(second, error => error instanceof UpstreamBusyError && error.reason === "closing");
  await tick();
  const closing = transport.close(200);
  assert.equal(transport.close(), closing);
  assert.equal(await closing, true);
  await Promise.all([checkedFirst, checkedSecond]);
  await assert.rejects(transport.request("https://internal.test"), UpstreamBusyError);
});

test("an abort-ignoring operation makes close explicitly report an incomplete drain", async () => {
  const response = deferred<Response>();
  const transport = new UpstreamTransport({ fetchImpl: () => response.promise });
  const pending = assert.rejects(transport.request("https://internal.test"), UpstreamCancelledError);
  await tick();
  assert.equal(await transport.close(10), false);
  await pending;
  response.resolve(json({ data: [] }));
  await tick();
  assert.equal(transport.snapshot().data.active, 0);
});

test("response byte boundaries are inclusive, UTF-8 chunks can split, and invalid encoding fails closed", async () => {
  const encoded = new TextEncoder().encode('{"data":"浪"}');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close();
  } });
  const signal = new AbortController().signal;
  const result = await bufferUpstreamResponse(new Response(body, { headers: { "content-type": "application/json" } }), encoded.length, signal);
  assert.deepEqual(upstreamJsonPayload(result), { data: "浪" });
  const bad = await bufferUpstreamResponse(new Response(new Uint8Array([0xff])), 10, signal);
  assert.throws(() => upstreamJsonPayload(bad), UpstreamResponseError);
  await assert.rejects(bufferUpstreamResponse(json({ data: [] }), 1, signal), UpstreamResponseError);
});

test("a stream that throws or rejects cancel cannot leak its diagnostics or pin the response", async () => {
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error("Bearer private")); }, cancel() { return new Promise(() => {}); },
  })) });
  await assert.rejects(transport.request("https://internal.test"), error => {
    assert.ok(error instanceof UpstreamResponseError);
    assert.doesNotMatch(error.message, /Bearer|private/);
    return true;
  });
  assert.equal(await transport.close(), true);
});

test("telemetry is bounded, cumulative and ignores malformed labels and numbers", () => {
  const telemetry = new UpstreamTelemetry();
  telemetry.observe({ kind: "api", outcome: "ok", durationMs: 50, bytes: 12, status: 201 });
  telemetry.observe({ kind: "auth", outcome: "timeout", durationMs: 100, bytes: 0 });
  telemetry.observe({ kind: "private-token" as "api", outcome: "ok", durationMs: 2, bytes: 0 });
  telemetry.observe({ kind: "api", outcome: "ok", durationMs: NaN, bytes: 0 });
  const rendered = telemetry.render(new UpstreamAdmission().snapshot());
  assert.match(rendered, /requests_total\{kind="api",outcome="ok"\} 1/);
  assert.match(rendered, /duration_seconds_bucket\{kind="api",le="0.05"\} 1/);
  assert.match(rendered, /response_bytes_total\{kind="api"\} 12/);
  assert.match(rendered, /invalid_samples_total 2/);
  assert.doesNotMatch(rendered, /private-token|NaN|undefined/);
  assert.ok(rendered.length < 32_768);
});

test("observer failure cannot replay or invalidate a successful operation", async () => {
  let calls = 0;
  const transport = new UpstreamTransport({ fetchImpl: async () => { calls++; return json({ data: true }); }, observer: () => { throw new Error("private"); } });
  assert.equal((await transport.request("https://internal.test", { method: "POST", body: "{}" })).status, 200);
  assert.equal(calls, 1);
  assert.equal(await transport.close(), true);
});

test("a synchronous injected failure clears the deadline and cancellation is not called a timeout", async () => {
  const error = new TypeError("original");
  await assert.rejects(withUpstreamDeadline(1000, () => { throw error; }), failure => failure === error);
  const controller = new AbortController();
  const work = withUpstreamDeadline(1000, () => new Promise<never>(() => {}), controller.signal);
  controller.abort("private reason");
  await assert.rejects(work, failure => failure instanceof UpstreamCancelledError && !failure.message.includes("private"));
});
