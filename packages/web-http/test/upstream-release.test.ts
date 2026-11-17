import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTransport } from "../src/upstream.ts";
import { UpstreamTimeoutError } from "../src/api.ts";
import { UpstreamBusyError, UpstreamResponseError } from "../src/upstream-errors.ts";
import { UpstreamTelemetry, type UpstreamSample } from "../src/upstream-telemetry.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function cancellationReceipt() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("a timed-out body returns promptly but cannot release physical capacity before cancel acknowledgement", async t => {
  const cancellation = cancellationReceipt();
  t.after(() => cancellation.resolve());
  const samples: UpstreamSample[] = [];
  const transport = new UpstreamTransport({ admission: { concurrency: 1, queue: 0, queueTimeoutMs: 10 },
    observer: sample => samples.push(sample), fetchImpl: async () => new Response(new ReadableStream({ cancel() { return cancellation.promise; } })) });
  await assert.rejects(transport.request("https://api.test", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
  await tick();
  const owned = transport.snapshot().data;
  assert.equal(owned.active, 1);
  assert.equal(owned.detached, 1, "the caller finished, but the physical operation did not");
  assert.equal(owned.cancelling, 1, "operators must distinguish an unacknowledged body cancellation from an active API request");
  assert.ok(owned.oldestDetachedMs >= 0); assert.ok(owned.oldestCancellingMs >= 0);
  assert.equal(await transport.close(10), false);
  cancellation.resolve(); await tick();
  assert.equal(transport.snapshot().data.active, 0);
  assert.equal(transport.snapshot().data.detached, 0);
  assert.equal(transport.snapshot().data.cancelling, 0);
  assert.equal(transport.snapshot().data.oldestDetachedMs, 0);
  assert.equal(transport.snapshot().data.oldestCancellingMs, 0);
  assert.deepEqual(transport.snapshot().data.cancellation, { acknowledged: 1, rejected: 0, totalMs: transport.snapshot().data.cancellation.totalMs });
  assert.deepEqual(samples.map(sample => sample.outcome), ["timeout"]);
});

test("browser cancellation of a download never waits for the source but retains its bulk lease", async t => {
  const cancellation = cancellationReceipt();
  t.after(() => cancellation.resolve());
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { return cancellation.promise; } })) });
  const response = await transport.openStream("https://api.test/export");
  await response.body!.cancel(); await tick();
  assert.equal(transport.snapshot().bulk.active, 1);
  assert.equal(await transport.close(10), false);
  cancellation.resolve(); await tick();
  assert.equal(transport.snapshot().bulk.active, 0);
});

test("a declared body-size rejection cannot hide a source that refuses cancellation", async t => {
  const cancellation = cancellationReceipt();
  t.after(() => cancellation.resolve());
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({ cancel() { return cancellation.promise; } }),
    { headers: { "content-type": "application/json", "content-length": "100" } }) });
  await assert.rejects(transport.openStream("https://api.test/export", {}, { maxBytes: 10 }), UpstreamResponseError);
  assert.equal(transport.snapshot().bulk.active, 1);
  assert.equal(await transport.close(10), false);
  cancellation.resolve(); await tick();
  assert.equal(transport.snapshot().bulk.active, 0);
});


test("a rejected source cancellation is observed once per physical operation without leaking its diagnostics", async () => {
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream({
    cancel() { return Promise.reject(new Error("private-cancel-ack-canary")); },
  })) });
  await assert.rejects(transport.request("https://api.test", {}, { timeoutMs: 10 }), UpstreamTimeoutError);
  await tick();
  const snapshot = transport.snapshot();
  assert.equal(snapshot.data.active, 0);
  assert.equal(snapshot.data.cancellation.acknowledged, 0);
  assert.equal(snapshot.data.cancellation.rejected, 1, "abort and finally can cancel the same reader, but own one operation");
  assert.ok(snapshot.data.cancellation.totalMs >= 0);
  const text = new UpstreamTelemetry().render(snapshot);
  assert.match(text, /web_upstream_cancel_acknowledgements_total\{lane="data",result="rejected"\} 1/);
  assert.match(text, /web_upstream_cancel_ack_seconds_total\{lane="data"\} [0-9]/);
  assert.doesNotMatch(text, /private-cancel-ack-canary|api\.test/);
  snapshot.data.cancellation.rejected = 900;
  assert.equal(transport.snapshot().data.cancellation.rejected, 1);
  assert.equal(await transport.close(), true);
});

for (const mode of ["buffered", "bulk"] as const) {
  for (const rejection of ["locked-reader", "media-type", "declared-length"] as const) {
    test(`${mode} ${rejection} cannot report an already-locked source as physically drained`, async t => {
      let cancelCalls = 0, fetchCalls = 0;
      const source = new ReadableStream<Uint8Array>({ cancel() { cancelCalls++; } }, { highWaterMark: 0 });
      const response = new Response(source, { headers: {
        "content-type": rejection === "media-type" ? "text/html" : "application/json",
        ...(rejection === "declared-length" ? { "content-length": "100" } : {}),
      } });
      // A broken fetch adapter handed us another owner's reader. Neither a
      // rejected stream.cancel() nor a failed getReader() proves it has ended.
      const owner = response.body!.getReader();
      t.after(async () => { await owner.cancel(); owner.releaseLock(); });
      const transport = new UpstreamTransport({ admission: { concurrency: 1, queue: 0, queueTimeoutMs: 10 },
        fetchImpl: async () => { fetchCalls++; return response; } });
      const operation = mode === "buffered"
        ? transport.request("https://api.test/locked", {}, { responseType: "json", maxBytes: 10 })
        : transport.openStream("https://api.test/locked", {}, { maxBytes: 10 });
      await assert.rejects(operation, UpstreamResponseError);
      await tick();
      const lane = transport.snapshot()[mode === "buffered" ? "data" : "bulk"];
      assert.equal(lane.active, 1, "unknown source ownership must not create replacement capacity");
      assert.equal(lane.detached, 1);
      assert.equal(lane.cancelling, 1);
      assert.equal(lane.cancellation.acknowledged, 0);
      assert.equal(lane.cancellation.rejected, 0, "no cancellation was delivered to the locked source");
      assert.equal(cancelCalls, 0);
      if (mode === "buffered") {
        await assert.rejects(transport.request("https://api.test/replacement"), UpstreamBusyError);
        assert.equal(fetchCalls, 1);
      }
      assert.equal(await transport.close(10), false);
    });
  }
}
