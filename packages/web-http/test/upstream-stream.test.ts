import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamBusyError, UpstreamCancelledError, UpstreamResponseError } from "../src/upstream-errors.ts";
import { UpstreamTimeoutError } from "../src/api.ts";
import type { UpstreamSample } from "../src/upstream-telemetry.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("bulk responses are pulled on demand and retain admission until consumed", async () => {
  let pulls = 0;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++; controller.enqueue(new TextEncoder().encode(pulls === 1 ? '{"data":' : '[]}')); if (pulls === 2) controller.close();
  } }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }) });
  const response = await transport.openStream("https://internal.test/export", {}, { kind: "export" });
  assert.equal(pulls, 0);
  assert.equal(transport.snapshot().bulk.active, 1);
  assert.equal(await response.text(), '{"data":[]}');
  await tick();
  assert.equal(pulls, 2);
  assert.equal(transport.snapshot().bulk.active, 0);
  assert.equal(await transport.close(), true);
});

test("cancelled downloads stop the source and are observed exactly once", async () => {
  let cancelled = false;
  const samples: UpstreamSample[] = [];
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), observer: sample => samples.push(sample) });
  const response = await transport.openStream("https://internal.test/export", {}, { kind: "export" });
  await response.body!.cancel(); await tick();
  assert.equal(cancelled, true);
  assert.equal(transport.snapshot().bulk.active, 0);
  assert.deepEqual(samples.map(sample => sample.outcome), ["cancelled"]);
  assert.equal(await transport.close(), true);
});

test("a download's body still shares the connection deadline after its headers were delivered", async () => {
  let cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const response = await transport.openStream("https://internal.test/export", {}, { kind: "export", timeoutMs: 20 });
  await assert.rejects(response.text(), UpstreamTimeoutError);
  await tick();
  assert.equal(cancelled, true);
  assert.equal(transport.snapshot().bulk.active, 0);
  assert.equal(await transport.close(), true);
});

test("dishonest streamed length fails the download without buffering beyond its ceiling", async () => {
  let cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json", "content-length": "1" } }) });
  const response = await transport.openStream("https://internal.test/export", {}, { kind: "export", maxBytes: 10 });
  await assert.rejects(response.arrayBuffer(), UpstreamResponseError);
  await tick();
  assert.equal(cancelled, true);
  assert.equal(transport.snapshot().bulk.active, 0);
  assert.equal(await transport.close(), true);
});

test("a declared oversized download is rejected before a browser response is exposed", async () => {
  let cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { "content-type": "application/json", "content-length": "100" } }) });
  await assert.rejects(transport.openStream("https://internal.test/export", {}, { kind: "export", maxBytes: 10 }), UpstreamResponseError);
  assert.equal(cancelled, true);
  assert.equal(await transport.close(), true);
});

test("bulk stream saturation does not borrow another lane or silently retry a download", async () => {
  let calls = 0;
  const transport = new UpstreamTransport({ fetchImpl: async () => { calls++; return new Response(new ReadableStream()); } });
  const first = await transport.openStream("https://internal.test/export", {}, { kind: "export" });
  const waiting = [transport.openStream("https://internal.test/export", {}, { kind: "export" }), transport.openStream("https://internal.test/export", {}, { kind: "export" })];
  const checked = waiting.map(promise => assert.rejects(promise, UpstreamBusyError));
  await tick();
  await assert.rejects(transport.openStream("https://internal.test/export", {}, { kind: "export" }), UpstreamBusyError);
  await transport.close();
  await assert.rejects(first.text(), UpstreamCancelledError);
  await Promise.all(checked);
  assert.equal(calls, 1);
});

test("shutdown cancels an unconsumed download and closes within its own finite budget", async () => {
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream()) });
  const response = await transport.openStream("https://internal.test/export", {}, { kind: "export" });
  assert.equal(await transport.close(100), true);
  await assert.rejects(response.text(), UpstreamCancelledError);
});
