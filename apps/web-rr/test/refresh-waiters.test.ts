import assert from "node:assert/strict";
import test from "node:test";
import { RefreshWaiters } from "../refresh/request-waiters.ts";

function deferred() { let resolve!: (value: string) => void; return { promise: new Promise<string>(done => { resolve = done; }), resolve: (value: string) => resolve(value) }; }

test("a canceled waiter releases only its request, never the shared rotation owned by its sibling", async () => {
  const waiters = new RefreshWaiters(3, 2), callback = deferred(), stop = new AbortController(); let began = 0;
  const work = () => { began++; return callback.promise; };
  const canceled = waiters.join("key", work, { signal: stop.signal, timeoutMs: 1000 });
  const sibling = waiters.join("key", () => callback.promise, { timeoutMs: 1000 });
  const rejected = assert.rejects(canceled); await Promise.resolve(); stop.abort(); await rejected;
  assert.equal(waiters.snapshot().active, 1); callback.resolve("rotated"); assert.equal(await sibling, "rotated");
  assert.equal(began, 1); assert.deepEqual(waiters.snapshot(), { active: 0, keys: 0, closed: false }); waiters.close();
});

test("per-key/global waiter admission and deadlines are bounded before work is started", async () => {
  const waiters = new RefreshWaiters(2, 1), blocked = deferred(); let deniedStarted = false;
  const first = waiters.join("one", () => blocked.promise, { timeoutMs: 30 });
  const rejected = assert.rejects(first);
  await assert.rejects(waiters.join("one", async () => { deniedStarted = true; return "bad"; }, { timeoutMs: 1000 }));
  const second = waiters.join("two", () => blocked.promise, { timeoutMs: 1000 });
  await assert.rejects(waiters.join("three", async () => { deniedStarted = true; return "bad"; }, { timeoutMs: 1000 }));
  await rejected; assert.equal(waiters.snapshot().active, 1); assert.equal(deniedStarted, false);
  const secondRejected = assert.rejects(second); waiters.close(); await secondRejected;
  blocked.resolve("late");
});
