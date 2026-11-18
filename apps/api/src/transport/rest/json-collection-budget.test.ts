import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JsonCollectionBudget, JsonCollectionBoundaryError, configureJsonCollectionOutput, jsonCollectionOutputSettings, takeJsonCollectionOutput } from "./json-collection-budget.ts";
import { sendJsonCollection } from "./json-collection.ts";
import { createApiServer } from "../../server.ts";

function expectReason(work: () => unknown, reason: JsonCollectionBoundaryError["reason"]) {
  assert.throws(work, error => error instanceof JsonCollectionBoundaryError && error.reason === reason);
}

test("producer settings have a bounded independent deadline and reject untrusted values without reflecting them", () => {
  assert.deepEqual(jsonCollectionOutputSettings({}), { timeoutMs: 120_000 });
  for (const value of ["100", "600000"]) assert.deepEqual(jsonCollectionOutputSettings({ API_COLLECTION_WRITE_TIMEOUT_MS: value }), { timeoutMs: Number(value) });
  for (const value of ["0", "99", "600001", "-10", "1e3", "100.5", " 100", "private-timeout-canary"]) {
    assert.throws(() => createApiServer({ env: { API_COLLECTION_WRITE_TIMEOUT_MS: value }, logger: () => {} }), error => {
      assert.ok(error instanceof RangeError); assert.doesNotMatch(error.message, /private-timeout-canary/); return true;
    });
  }
  const first = {} as ServerResponse, second = {} as ServerResponse;
  configureJsonCollectionOutput(first, { timeoutMs: 100 });
  configureJsonCollectionOutput(second, { timeoutMs: 200 });
  assert.deepEqual(takeJsonCollectionOutput(first), { timeoutMs: 100 });
  assert.equal(takeJsonCollectionOutput(first), undefined);
  assert.deepEqual(takeJsonCollectionOutput(second), { timeoutMs: 200 });
});

test("budget charges exact byte boundaries independently, resets each item, and cannot raise the public fences", () => {
  const budget = new JsonCollectionBudget({ maxItems: 2, itemBytes: 6, envelopeBytes: 3 }, () => assert.fail("not timed out"));
  try {
    budget.validateCount(2); expectReason(() => budget.validateCount(3), "items");
    budget.charge(3, "envelope"); expectReason(() => budget.charge(1, "envelope"), "envelope");
    for (let index = 0; index < 2; index++) {
      budget.beginItem(); assert.throws(() => budget.beginItem(), /not finished/);
      budget.charge(Buffer.byteLength("浪浪"), "item"); expectReason(() => budget.charge(1, "item"), "item");
      budget.endItem();
    }
    expectReason(() => budget.beginItem(), "items");
    assert.throws(() => budget.endItem(), /not started/);
    expectReason(() => budget.charge(65537, "envelope"), "chunk");
  } finally { budget.dispose(); budget.dispose(); }
  for (const limits of [{ itemBytes: 8 * 1024 * 1024 + 1 }, { envelopeBytes: 65537 }, { maxItems: 301 }, { timeoutMs: 600001 }, { itemBytes: 0 }, { maxItems: 1.5 }]) {
    assert.throws(() => new JsonCollectionBudget(limits, () => {}), RangeError);
  }
});

test("dispose prevents delayed callbacks from retaining or destroying a completed response", async () => {
  let expired = 0;
  const budget = new JsonCollectionBudget({ timeoutMs: 5 }, () => expired++);
  budget.dispose();
  await delay(15);
  assert.equal(expired, 0);
  assert.throws(() => budget.checkpoint(), /closed/);
});

test("waiting for native socket finish is covered, not just waiting for drain", { timeout: 1000 }, async () => {
  class FinishStalledResponse extends EventEmitter {
    destroyed = false; writableEnded = false; headersSent = false;
    writeHead() { this.headersSent = true; }
    write() { return true; }
    end() { this.writableEnded = true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const socket = new FinishStalledResponse(), response = socket as unknown as ServerResponse;
  configureJsonCollectionOutput(response, { timeoutMs: 20 });
  await assert.rejects(sendJsonCollection(response, [1]), /deadline/i);
  assert.equal(socket.destroyed, true);
  for (const event of ["drain", "finish", "close", "error"]) assert.equal(socket.listenerCount(event), 0);
});
