import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BoundedRefreshGate } from "../refresh/work-gate.ts";

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

test("a timed-out driver still owns its slot; queued work cannot create a replacement query storm", async () => {
  const gate = new BoundedRefreshGate(1, 2);
  const blocked = deferred(); let started = 0;
  const first = gate.run(async () => { started++; await blocked.promise; }, 30);
  await assert.rejects(first, /coordination/);
  assert.equal(gate.snapshot().active, 1);
  await assert.rejects(gate.run(async () => { started++; }, 30));
  assert.equal(started, 1);
  blocked.resolve(); await delay(0);
  await gate.run(async () => { started++; }, 100);
  assert.equal(started, 2);
  assert.deepEqual(gate.snapshot(), { active: 0, queued: 0, closed: false });
  gate.close();
});

test("closing the gate cancels queued waiters without running them and drains actual driver work", async () => {
  const gate = new BoundedRefreshGate(1, 1);
  const blocked = deferred(); const entered = deferred();
  const active = gate.run(async () => { entered.resolve(); await blocked.promise; }, 2000);
  await entered.promise;
  let queuedRan = false;
  const queued = gate.run(async () => { queuedRan = true; }, 2000);
  const activeRejected = assert.rejects(active), queuedRejected = assert.rejects(queued);
  gate.close(); await Promise.all([activeRejected, queuedRejected]);
  assert.equal(await gate.drain(10), false);
  blocked.resolve(); assert.equal(await gate.drain(1000), true);
  assert.equal(queuedRan, false);
  await assert.rejects(gate.run(async () => {}, 100));
});
