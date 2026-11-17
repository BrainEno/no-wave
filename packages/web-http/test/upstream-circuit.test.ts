import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamCircuit } from "../src/upstream-circuit.ts";
import { UpstreamBusyError } from "../src/upstream-errors.ts";

function fixture() { let now = 0; return { circuit: new UpstreamCircuit({ threshold: 2, cooldownMs: 100, now: () => now }), advance: (ms: number) => { now += ms; } }; }

test("consecutive transport failures open only their lane, then exactly one recovery probe is allowed", () => {
  const { circuit, advance } = fixture();
  for (let index = 0; index < 2; index++) { const permit = circuit.enter("data"); permit.report("failure"); permit.release(); }
  assert.equal(circuit.snapshot().data.state, "open");
  assert.throws(() => circuit.enter("data"), error => error instanceof UpstreamBusyError && error.reason === "circuit-open");
  const auth = circuit.enter("auth"); auth.report("healthy"); auth.release();
  advance(100);
  const probe = circuit.enter("data");
  assert.equal(circuit.snapshot().data.state, "half-open");
  assert.throws(() => circuit.enter("data"), UpstreamBusyError);
  probe.report("healthy"); probe.release();
  assert.equal(circuit.snapshot().data.state, "closed");
});

test("a late success from before the trip cannot close the circuit", () => {
  const { circuit } = fixture();
  const late = circuit.enter("data");
  for (let index = 0; index < 2; index++) { const permit = circuit.enter("data"); permit.report("failure"); permit.release(); }
  late.report("healthy"); late.release();
  assert.equal(circuit.snapshot().data.state, "open");
});

test("a timed-out abort-ignoring recovery probe retains exclusive probe ownership", () => {
  const { circuit, advance } = fixture();
  for (let index = 0; index < 2; index++) { const permit = circuit.enter("bulk"); permit.report("failure"); permit.release(); }
  advance(100);
  const probe = circuit.enter("bulk"); probe.report("failure");
  advance(1000);
  assert.throws(() => circuit.enter("bulk"), UpstreamBusyError);
  probe.release(); probe.release();
  const next = circuit.enter("bulk"); next.report("healthy"); next.release();
  assert.equal(circuit.snapshot().bulk.state, "closed");
});

test("business rejection proves reachability, while caller cancellation is neutral", () => {
  const { circuit } = fixture();
  const first = circuit.enter("data"); first.report("failure"); first.release();
  const cancelled = circuit.enter("data"); cancelled.report("neutral"); cancelled.release();
  assert.equal(circuit.snapshot().data.failures, 1);
  const rejected = circuit.enter("data"); rejected.report("healthy"); rejected.release();
  assert.equal(circuit.snapshot().data.failures, 0);
});

test("circuit settings reject invalid or unbounded timing without retaining input values", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 1_000_000]) {
    assert.throws(() => new UpstreamCircuit({ threshold: value }), RangeError);
    assert.throws(() => new UpstreamCircuit({ cooldownMs: value }), RangeError);
  }
});
