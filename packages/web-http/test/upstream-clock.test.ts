import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamTimeoutError, withUpstreamDeadline } from "../src/api.ts";
import { UpstreamAdmission } from "../src/upstream-admission.ts";
import { UpstreamBusyError } from "../src/upstream-errors.ts";
import { UpstreamTransport } from "../src/upstream.ts";
import { json } from "./helpers.ts";

// Deliberately starve timers, rather than mocking the clock or production code.
function stallTimers() {
  const until = performance.now() + 20;
  while (performance.now() < until) { /* bounded CPU fixture */ }
}

test("a resolved operation cannot turn an elapsed deadline into success while its timer is starved", async () => {
  await assert.rejects(withUpstreamDeadline(5, async () => { stallTimers(); return "late"; }), UpstreamTimeoutError);
});

test("FIFO release refuses an expired waiter even before the expiry timer gets a turn", async () => {
  const admission = new UpstreamAdmission({ concurrency: 1, queue: 1, queueTimeoutMs: 5 });
  const first = await admission.acquire("data");
  const queued = admission.acquire("data");
  const refused = assert.rejects(queued, error => error instanceof UpstreamBusyError && error.reason === "queue-timeout");
  stallTimers(); first.release(); await refused;
  assert.equal(admission.snapshot().data.active, 0);
  assert.equal(admission.snapshot().data.wait.count, 2);
});

test("an elapsed absolute deadline forbids a queued mutation from reaching fetch even when timers have not fired", async t => {
  let calls = 0;
  let finish!: (response: Response) => void;
  const transport = new UpstreamTransport({ admission: { concurrency: 1, queue: 1, queueTimeoutMs: 1000 },
    fetchImpl: async () => { calls++; return calls === 1 ? new Promise<Response>(resolve => { finish = resolve; }) : json({ data: true }); } });
  t.after(() => finish?.(json({ data: true })));
  const first = transport.request("https://api.test/first", {}, { timeoutMs: 1000 });
  await new Promise<void>(resolve => setImmediate(resolve));
  const queued = transport.request("https://api.test/mutation", { method: "POST", body: "{}" }, { timeoutMs: 5 });
  const refused = assert.rejects(queued, UpstreamTimeoutError);
  await Promise.resolve(); stallTimers(); finish(json({ data: true }));
  await first; await refused;
  assert.equal(calls, 1, "never dispatch a side effect after its public deadline");
  assert.equal(await transport.close(), true);
});

test("late download headers cancel the source rather than expose an already-expired attachment", async () => {
  let cancelled = false;
  const transport = new UpstreamTransport({ fetchImpl: async () => {
    stallTimers();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  } });
  await assert.rejects(transport.openStream("https://api.test/export", {}, { timeoutMs: 5 }), UpstreamTimeoutError);
  assert.equal(cancelled, true);
  assert.equal(await transport.close(), true);
});

test("a download read that starves timers cannot enqueue bytes after its absolute deadline", async () => {
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { stallTimers(); controller.enqueue(new TextEncoder().encode('{}')); controller.close(); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } }) });
  const response = await transport.openStream("https://api.test/export", {}, { timeoutMs: 5 });
  await assert.rejects(response.arrayBuffer(), UpstreamTimeoutError);
  assert.equal(await transport.close(), true);
});

test("already-resolved empty upstream chunks cannot postpone the buffered deadline until EOF", async () => {
  let reads = 0;
  const end = 100_000;
  const transport = new UpstreamTransport({ fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ < end) controller.enqueue(new Uint8Array(0)); else controller.close();
  } }, { highWaterMark: 0 })) });
  await assert.rejects(transport.request("https://api.test", {}, { timeoutMs: 5 }), UpstreamTimeoutError);
  assert.ok(reads < end);
  assert.equal(await transport.close(), true);
});
