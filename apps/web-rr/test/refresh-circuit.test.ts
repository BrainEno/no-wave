import assert from "node:assert/strict";
import test from "node:test";
import { RefreshDatabaseCircuit } from "../refresh/database-circuit.ts";
import { RefreshCoordinationError } from "../refresh/errors.ts";

test("database failures open bounded backoff and admit exactly one recovery probe", async () => {
  let now = 1000, queries = 0;
  const circuit = new RefreshDatabaseCircuit({ threshold: 2, baseDelayMs: 100, maximumDelayMs: 400, now: () => now });
  const fail = async () => { queries++; throw new RefreshCoordinationError("database"); };
  await assert.rejects(circuit.run(fail)); await assert.rejects(circuit.run(fail));
  assert.equal(circuit.snapshot().state, "open"); await assert.rejects(circuit.run(fail)); assert.equal(queries, 2);
  now += 100; let release!: () => void;
  const probe = circuit.run(async () => { queries++; await new Promise<void>(done => { release = done; }); return "recovered"; });
  await Promise.resolve(); await assert.rejects(circuit.run(fail)); assert.equal(queries, 3);
  release(); assert.equal(await probe, "recovered"); assert.equal(circuit.snapshot().state, "closed");
});

test("late success cannot reset a newer outage and shutdown never admits work", async () => {
  let now = 0; const circuit = new RefreshDatabaseCircuit({ threshold: 1, baseDelayMs: 10, maximumDelayMs: 40, now: () => now });
  let release!: () => void;
  const old = circuit.run(async () => { await new Promise<void>(done => { release = done; }); });
  await assert.rejects(circuit.run(async () => { throw new RefreshCoordinationError("database"); }));
  release(); await old; assert.equal(circuit.snapshot().state, "open");
  now = 10; await assert.rejects(circuit.run(async () => { throw new RefreshCoordinationError("database"); }));
  assert.equal(circuit.snapshot().retryAfterMs, 20);
  circuit.close(); await assert.rejects(circuit.run(async () => { assert.fail("closed circuit started work"); }));
});
