import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamTimeoutError } from "../src/api.ts";
import { UpstreamBusyError, UpstreamCancelledError, UpstreamResponseError } from "../src/upstream-errors.ts";
import type { UpstreamSample } from "../src/upstream-telemetry.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const headers = { "content-type": "application/json" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

for (const method of ["open", "read"] as const) {
  test(`${method} collection cancellation/deadline returns promptly but pins its data lease until physical acknowledgement`, async t => {
    const receipt = deferred(); t.after(receipt.resolve);
    const samples: UpstreamSample[] = [];
    const transport = new UpstreamTransport({ admission: { concurrency: 1, queue: 0, queueTimeoutMs: 10 }, observer: sample => samples.push(sample),
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { return receipt.promise; } }), { headers }) });
    if (method === "read") await assert.rejects(transport.readCollection("https://api.test/articles", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
    else { const response = await transport.openCollection("https://api.test/articles"); await response.body!.cancel(); }
    await tick();
    assert.equal(transport.snapshot().data.active, 1);
    assert.equal(transport.snapshot().data.detached, 1);
    assert.equal(transport.snapshot().data.cancelling, 1);
    assert.equal(transport.snapshot().bulk.active, 0, "ordinary collections never borrow export slots");
    await assert.rejects(transport.openCollection("https://api.test/replacement"), UpstreamBusyError);
    assert.equal(await transport.close(10), false);
    receipt.resolve(); await tick();
    assert.equal(transport.snapshot().data.active, 0);
    assert.equal(samples.filter(sample => sample.outcome === (method === "read" ? "timeout" : "cancelled")).length, 1);
  });
}

test("one giant adapter chunk is emitted in bounded demand-driven slices without fetching a later chunk", async () => {
  let produced = 0, cancelled = false;
  const bytes = new TextEncoder().encode('{"data":["' + "浪".repeat(100_000) + '"]}');
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { produced++; controller.enqueue(bytes); }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers }) });
  const response = await transport.openCollection("https://api.test/articles");
  assert.equal(produced, 0);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.ok(first.value && first.value.byteLength <= 64 * 1024, "forwarding must not copy/enqueue a giant adapter chunk at once");
  assert.equal(produced, 1);
  assert.equal(transport.snapshot().data.active, 1);
  await reader.cancel(); reader.releaseLock(); await tick();
  assert.equal(cancelled, true);
  assert.equal(produced, 1);
  assert.equal(await transport.close(), true);
});

for (const kind of ["reader", "content-type", "declared-length"] as const) {
  test(`collection ${kind} rejection never reclaims a source already owned by another reader`, async t => {
    let fetched = 0, cancelled = 0;
    const source = new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: {
      "content-type": kind === "content-type" ? "text/html" : "application/json", ...(kind === "declared-length" ? { "content-length": "9999999999" } : {}),
    } });
    const owner = source.body!.getReader(); t.after(async () => { await owner.cancel(); owner.releaseLock(); });
    const transport = new UpstreamTransport({ admission: { concurrency: 1, queue: 0, queueTimeoutMs: 10 }, fetchImpl: async () => { fetched++; return source; } });
    await assert.rejects(transport.openCollection("https://api.test/articles"), UpstreamResponseError);
    await tick();
    assert.equal(cancelled, 0);
    assert.equal(transport.snapshot().data.active, 1);
    assert.equal(transport.snapshot().data.cancellation.acknowledged, 0);
    await assert.rejects(transport.openCollection("https://api.test/replacement"), UpstreamBusyError);
    assert.equal(fetched, 1);
    assert.equal(await transport.close(10), false);
  });
}

test("late collection fetch completion cancels the real source without releasing its slot before the receipt", async t => {
  const headersReady = deferred(), cancellation = deferred(); t.after(cancellation.resolve);
  let cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => { await headersReady.promise; return new Response(new ReadableStream({ cancel() { cancelled = true; return cancellation.promise; } }), { headers }); } });
  await assert.rejects(transport.readCollection("https://api.test/articles", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
  assert.equal(transport.snapshot().data.active, 1);
  headersReady.resolve(); await tick();
  assert.equal(cancelled, true);
  assert.equal(transport.snapshot().data.active, 1);
  cancellation.resolve(); await tick();
  assert.equal(transport.snapshot().data.active, 0);
  assert.equal(await transport.close(), true);
});

test("successful prefixes, fatal UTF-8 and a missing EOF are never returned as a successful partial page", async () => {
  for (const text of ['{"data":[1,2]', '{"data":[1,2]} trailing', '{"data":["\ufffd"]}']) {
    const raw = new TextEncoder().encode(text);
    if (text.includes("\ufffd")) raw[raw.indexOf(0xef)] = 0xff;
    const transport = new UpstreamTransport({ fetchImpl: async () => new Response(raw, { headers }) });
    await assert.rejects(transport.readCollection("https://api.test/articles"), UpstreamResponseError);
    assert.equal(await transport.close(), true);
  }
  const controller = new AbortController();
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ start(source) { source.enqueue(new TextEncoder().encode('{"data":[1]}')); } }), { headers }) });
  const read = transport.readCollection("https://api.test/articles", {}, { signal: controller.signal });
  const checked = assert.rejects(read, UpstreamCancelledError);
  await tick(); controller.abort(); await checked;
  assert.equal(await transport.close(), true);
});

 test("collection item limits use decoded bytes even with compressed framing headers", async () => {
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response('{"data":["浪浪"]}', { headers: { ...headers, "content-encoding": "gzip", "content-length": "1" } }) });
  await assert.rejects(transport.readCollection("https://api.test/articles", {}, { itemBytes: 7 }), error => error instanceof UpstreamResponseError && error.reason === "too-large");
  assert.equal(await transport.close(), true);
});

test("cancelling a retained collection poisons its decoder without cancelling physical ownership twice", async () => {
  const { CollectionJsonDecoder } = await import("../src/collection-json.ts");
  const { UpstreamBodyStream } = await import("../src/upstream-stream.ts");
  const cancelled = new UpstreamCancelledError();
  const decoder = new CollectionJsonDecoder();
  decoder.write(new TextEncoder().encode('{"data":[{"title":"retained item"}],'));
  decoder.abort(cancelled);
  assert.throws(() => decoder.finish(), error => error === cancelled);
  assert.throws(() => decoder.write(new TextEncoder().encode('"meta":{}}')), error => error === cancelled);
  assert.throws(() => decoder.payload());
  const complete = new CollectionJsonDecoder();
  complete.write(new TextEncoder().encode('{"data":[1]}')); complete.finish(); complete.abort(cancelled);
  assert.deepEqual(complete.payload().data, [1], "an already handed-off result belongs to its caller");
  let aborts = 0, sourceCancels = 0;
  const stream = new UpstreamBodyStream(new Response(new ReadableStream({ cancel() { sourceCancels++; } })), 1024,
    new AbortController().signal, { write() {}, finish() {}, abort(error) { aborts++; assert.ok(error instanceof UpstreamCancelledError); throw new Error("cleanup hook failure"); } });
  const ended = assert.rejects(stream.finished, UpstreamCancelledError);
  await stream.body.cancel(); await ended;
  assert.equal(aborts, 1); assert.equal(sourceCancels, 1);
});
