import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { createHttpObservability } from "../../infrastructure/http-observability.ts";
import { sendJsonCollection } from "./json-collection.ts";

class SocketResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  statusCode = 200;
  parts: Buffer[] = [];
  writes = 0;
  ends = 0;
  blockAt = -1;
  syncDrain = false;
  setHeader() {}
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  write(bytes: Buffer): boolean {
    this.parts.push(Buffer.from(bytes)); this.writes++;
    if (this.writes !== this.blockAt) return true;
    if (this.syncDrain) this.emit("drain");
    return false;
  }
  end() { this.ends++; this.writableEnded = true; this.emit("finish"); }
  destroy() { this.destroyed = true; this.emit("close"); }
  response(): ServerResponse { return this as unknown as ServerResponse; }
  text() { return Buffer.concat(this.parts).toString("utf8"); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("a stalled drain has an absolute output deadline, stops later work and destroys incomplete success", { timeout: 1000 }, async () => {
  const socket = new SocketResponse(); socket.blockAt = 2;
  let projected = 0;
  const writing = sendJsonCollection(socket.response(), [{ text: "a".repeat(100_000) }, { text: "must not be projected" }], {
    budget: { timeoutMs: 20 }, project(item) { projected++; return item; },
  });
  await assert.rejects(writing, /deadline/i);
  assert.equal(projected, 1);
  assert.equal(socket.destroyed, true);
  assert.equal(socket.ends, 0);
  assert.throws(() => JSON.parse(socket.text()));
  for (const event of ["drain", "finish", "close", "error"]) assert.equal(socket.listenerCount(event), 0);
});

test("a synchronous projection cannot commit success after consuming the output deadline", async () => {
  const socket = new SocketResponse();
  await assert.rejects(sendJsonCollection(socket.response(), [1], { budget: { timeoutMs: 5 }, project() {
    const until = performance.now() + 20;
    while (performance.now() < until) { /* A getter/serializer can delay the timer. */ }
    return 1;
  } }), /deadline/i);
  assert.equal(socket.headersSent, false);
  assert.equal(socket.parts.length, 0);
});

test("writer fences count UTF-8 per item and metadata without pretending an oversized page completed", async () => {
  for (const part of ["item", "envelope", "count"] as const) {
    const socket = new SocketResponse();
    const data = part === "count" ? [1, 2] : [{ text: "浪".repeat(10) }];
    await assert.rejects(sendJsonCollection(socket.response(), data, { budget: { itemBytes: part === "item" ? 20 : 256,
      envelopeBytes: part === "envelope" ? 16 : 256, maxItems: part === "count" ? 1 : 2 },
      ...(part === "envelope" ? { meta: { cursor: "c".repeat(100) } } : {}) }), /limit|bound/i);
    assert.equal(socket.ends, 0);
    if (socket.headersSent) { assert.equal(socket.destroyed, true); assert.throws(() => JSON.parse(socket.text())); }
  }
});

 test("socket-backpressured JSON preserves native envelopes and reports actual completed output", async () => {
  const socket = new SocketResponse();
  const observability = createHttpObservability({ logger: () => {} });
  observability.beginRequest({ method: "GET", url: "/api/v1/articles", headers: {} } as IncomingMessage, socket.response());
  const data = [{ text: "浪🙂\ud800" }, { code: "浪".repeat(100_000) }];
  await sendJsonCollection(socket.response(), data, { meta: { nextCursor: "opaque" } });
  assert.equal(socket.text(), JSON.stringify({ data, meta: { nextCursor: "opaque" } }));
  assert.ok(socket.parts.every(bytes => bytes.length <= 64 * 1024));
  assert.equal(socket.ends, 1);
  const metrics = observability.renderMetrics();
  assert.match(metrics, /api_http_collection_responses_total\{view="full",outcome="finished"\} 1/);
  assert.match(metrics, /api_http_collection_items_total\{view="full"\} 2/);
  assert.doesNotMatch(metrics, /opaque|浪|\/api\/v1\/articles/);
});

test("backpressure pauses traversal; closing a blocked socket cancels without projecting subsequent rows", async () => {
  const socket = new SocketResponse(); socket.blockAt = 2;
  let projects = 0, later = 0;
  const writing = sendJsonCollection(socket.response(), [{ text: "a".repeat(100_000), get later() { later++; return "late"; } }, { text: "second" }], { project: item => { projects++; return item; } });
  await tick();
  assert.equal(projects, 1);
  assert.equal(later, 0);
  assert.equal(socket.ends, 0);
  socket.destroy();
  await writing;
  assert.equal(projects, 1);
  assert.equal(later, 0);
  assert.equal(socket.ends, 0);
  assert.equal(socket.listenerCount("drain"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("synchronous and asynchronous drain acknowledgements cannot be lost", async () => {
  for (const sync of [true, false]) {
    const socket = new SocketResponse(); socket.blockAt = 1; socket.syncDrain = sync;
    const writing = sendJsonCollection(socket.response(), [1, 2]);
    if (!sync) { await tick(); assert.equal(socket.ends, 0); socket.emit("drain"); }
    await writing;
    assert.equal(socket.text(), '{"data":[1,2]}');
    assert.equal(socket.ends, 1);
    assert.equal(socket.listenerCount("drain"), 0);
  }
});

test("encoding failure after headers destroys partial JSON; failure in the bounded first chunk leaves headers uncommitted", async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const late = new SocketResponse();
  await assert.rejects(sendJsonCollection(late.response(), [{ text: "safe" }, cycle]), TypeError);
  assert.equal(late.destroyed, true);
  assert.equal(late.ends, 0);
  assert.throws(() => JSON.parse(late.text()));
  const early = new SocketResponse();
  await assert.rejects(sendJsonCollection(early.response(), [{ get fail() { throw new Error("early encoding failure"); } }]), /early encoding failure/);
  assert.equal(early.headersSent, false);
  assert.equal(early.parts.length, 0);
});
