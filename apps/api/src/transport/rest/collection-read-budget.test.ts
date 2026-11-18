import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CollectionReadBudget, CollectionReadEndedError, collectionReadBudgetFor, collectionReadTimeout } from "./collection-read-budget.ts";
import { sendServiceError } from "./http.ts";

function response() {
  const writes: Array<{ status: number; headers: unknown }> = [];
  const result = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, headersSent: false, payload: "",
    writeHead(status: number, headers: unknown) { result.headersSent = true; writes.push({ status, headers }); },
    end(payload: string) { result.payload = payload; result.writableEnded = true; result.emit("finish"); },
    destroy() { result.destroyed = true; result.emit("close"); },
  });
  return { socket: result, native: result as unknown as ServerResponse, writes };
}

test("a synchronous overrun cannot evade the read deadline by starving its timer", () => {
  const output = response(), budget = new CollectionReadBudget(output.native, 100);
  try {
    const until = performance.now() + 120;
    while (performance.now() < until) { /* Deliberately prevent the timer from running. */ }
    assert.throws(() => budget.checkpoint(), CollectionReadEndedError);
    assert.equal(budget.signal.aborted, true);
    assert.equal(output.writes[0]?.status, 504);
    assert.equal(JSON.parse(output.socket.payload).error.code, "COLLECTION_READ_TIMEOUT");
    sendServiceError(output.native, new Error("late driver detail"));
    assert.equal(output.socket.destroyed, false, "a late error must not destroy an already-ended timeout response before it flushes");
    assert.equal(output.writes.length, 1);
    assert.equal(collectionReadBudgetFor(output.native), budget, "the handler still owns the context until physical settlement");
  } finally { budget.dispose(); }
  assert.equal(collectionReadBudgetFor(output.native), undefined);
  for (const event of ["finish", "close"]) assert.equal(output.socket.listenerCount(event), 0);
});

test("successful metadata hands off to the output writer without a later read timer or aborted signal", async () => {
  const output = response(), budget = new CollectionReadBudget(output.native, 100);
  assert.throws(() => new CollectionReadBudget(output.native, 100), /already owns/);
  budget.complete(); budget.dispose();
  assert.equal(collectionReadBudgetFor(output.native), undefined);
  assert.equal(budget.signal.aborted, false);
  await delay(120);
  assert.equal(output.writes.length, 0);
  for (const event of ["finish", "close"]) assert.equal(output.socket.listenerCount(event), 0);
});

test("downstream cancellation and repeated disposal abort a reader once without fabricating a timeout response", () => {
  const output = response(), budget = new CollectionReadBudget(output.native, 100);
  let aborts = 0; budget.signal.addEventListener("abort", () => { aborts++; });
  output.socket.destroy(); budget.dispose(); budget.dispose();
  assert.equal(aborts, 1);
  assert.equal(output.writes.length, 0);
  assert.throws(() => budget.checkpoint(), CollectionReadEndedError);
  assert.equal(collectionReadBudgetFor(output.native), undefined);
  const ended = response(); ended.socket.writableEnded = true;
  const alreadyEnded = new CollectionReadBudget(ended.native, 100);
  assert.equal(alreadyEnded.signal.aborted, true); alreadyEnded.dispose();
});

test("read settings and direct constructors enforce finite bounds independently of the output deadline", () => {
  assert.equal(collectionReadTimeout({}), 120_000);
  for (const value of [100, 600_000]) assert.equal(collectionReadTimeout({ API_COLLECTION_READ_TIMEOUT_MS: String(value) }), value);
  for (const value of [0, 99, 600_001, NaN, Infinity, 100.5]) assert.throws(() => new CollectionReadBudget(response().native, value), RangeError);
});
