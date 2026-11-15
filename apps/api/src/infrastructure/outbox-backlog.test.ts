import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createOutboxMetrics } from "../persistence/outbox-metrics.ts";
import { createOutboxBacklogSampler } from "./outbox-backlog.ts";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert.ok(predicate(), "the sampler must reach the expected observable state");
}
const snapshot = { pendingEvents: 2, deadLetterEvents: 3, oldestPendingAgeMs: 400 };

test("optional metrics sampling returns immediately, times out once, and never launches overlapping reads for a stuck driver", async () => {
  const metrics = createOutboxMetrics();
  let reads = 0;
  const failures: unknown[] = [];
  const sampler = createOutboxBacklogSampler({ metrics, refreshIntervalMs: 10, timeoutMs: 25,
    read: () => { reads++; return new Promise(() => {}); }, onFailure: failure => failures.push(failure) });
  try {
    assert.equal(sampler.start(), undefined);
    sampler.start();
    await until(() => failures.length === 1);
    await delay(60);
    assert.equal(reads, 1);
    assert.deepEqual(failures, [{ reason: "timeout" }]);
    assert.match(metrics.render(), /^api_outbox_backlog_read_failures_total 1$/m);
    for (let index = 0; index < 20; index++) assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
    assert.equal(reads, 1, "scraping metrics cannot issue a database query");
  } finally { sampler.close(); }
});

test("last-good worker gauges keep monotonic age and last-success time across errors, then recover on a timely sample", async t => {
  // Control refresh ticks only; the reporting timeout still elapses in real time.
  // Recovery must not accidentally create a second intentionally hung fixture read.
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0, wall = 1_700_000_000_000;
  let mode: "ready" | "blocked" = "ready";
  let finish!: (value: unknown) => void;
  const metrics = createOutboxMetrics();
  const sampler = createOutboxBacklogSampler({ metrics, refreshIntervalMs: 15, timeoutMs: 25, now: () => now, wallNow: () => wall,
    read: () => mode === "ready" ? snapshot : new Promise(resolve => { finish = resolve; }) });
  try {
    sampler.start();
    await until(() => /notification_worker_backlog_available 1\n/.test(sampler.renderMetrics()));
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_sample_timestamp_seconds 1700000000$/m);
    mode = "blocked";
    t.mock.timers.tick(15);
    await until(() => Boolean(finish));
    now = 1100; wall -= 86_400_000;
    await until(() => /api_outbox_backlog_read_failures_total 1\n/.test(metrics.render()));
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_oldest_pending_age_seconds 1\.5$/m);
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_sample_timestamp_seconds 1700000000$/m);
    finish({ pendingEvents: 999, deadLetterEvents: 999, oldestPendingAgeMs: 999 });
    await setImmediate();
    assert.match(metrics.render(), /^api_outbox_pending_events 2$/m, "a timed-out completion cannot replace the trusted snapshot");
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
    mode = "ready";
    t.mock.timers.tick(15);
    await until(() => /notification_worker_backlog_available 1\n/.test(sampler.renderMetrics()));
    assert.match(metrics.render(), /^api_outbox_dead_letter_events 3$/m);
  } finally { sampler.close(); }
});

test("sampling failures retain good counts, classify without exception text, and tolerate a broken log observer", async () => {
  for (const reason of ["read_failed", "invalid_snapshot"] as const) {
    let bad = false;
    const metrics = createOutboxMetrics();
    const seen: unknown[] = [];
    const sampler = createOutboxBacklogSampler({ metrics, refreshIntervalMs: 10, timeoutMs: 50,
      read: () => { if (!bad) return snapshot; if (reason === "read_failed") throw new Error("private-observer-payload-canary"); return { ...snapshot, pendingEvents: -1 }; },
      onFailure: failure => { seen.push(failure); throw new Error("private-logging-canary"); } });
    try {
      sampler.start(); await until(() => /api_outbox_pending_events 2\n/.test(metrics.render()));
      bad = true; await until(() => seen.length > 0);
      assert.deepEqual(seen[0], { reason });
      assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
      assert.match(metrics.render(), /^api_outbox_pending_events 2$/m);
      assert.doesNotMatch(JSON.stringify(seen) + metrics.render() + sampler.renderMetrics(), /private-|payload|conversationId|postgres:\/\//);
    } finally { sampler.close(); }
  }
});

test("closing a sampler cancels timers and invalidates late results without pretending that an empty queue was sampled", async () => {
  const metrics = createOutboxMetrics();
  let reads = 0, finish!: (value: unknown) => void;
  const failures: unknown[] = [];
  const sampler = createOutboxBacklogSampler({ metrics, refreshIntervalMs: 10, timeoutMs: 20,
    read: () => { reads++; return new Promise(resolve => { finish = resolve; }); }, onFailure: failure => failures.push(failure) });
  sampler.start(); await until(() => reads === 1);
  sampler.close(); sampler.close(); finish(snapshot);
  await delay(50);
  assert.equal(reads, 1); assert.deepEqual(failures, []);
  assert.match(sampler.renderMetrics(), /^notification_worker_backlog_sample_age_seconds -1$/m);
  assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
  assert.match(metrics.render(), /^api_outbox_backlog_sample_timestamp_seconds 0$/m);
  assert.throws(() => sampler.start(), /closed/);
});

test("a cached empty queue remains age zero, stale samples fail closed, and sampler budgets are finite positive integers", async () => {
  let now = 0;
  const sampler = createOutboxBacklogSampler({ metrics: createOutboxMetrics(), refreshIntervalMs: 1000, timeoutMs: 50,
    now: () => now, read: () => ({ pendingEvents: 0, deadLetterEvents: 2, oldestPendingAgeMs: 0 }) });
  try {
    sampler.start(); await until(() => /notification_worker_backlog_available 1\n/.test(sampler.renderMetrics()));
    now = 2001;
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
    assert.match(sampler.renderMetrics(), /^notification_worker_backlog_oldest_pending_age_seconds 0$/m);
    for (const invalid of [0, -1, 0.5, NaN, Infinity, 60_001]) for (const field of ["refreshIntervalMs", "timeoutMs"] as const) {
      assert.throws(() => createOutboxBacklogSampler({ metrics: createOutboxMetrics(), refreshIntervalMs: 1000, timeoutMs: 500, read: () => snapshot, [field]: invalid }), RangeError);
    }
  } finally { sampler.close(); }
});

test("closing immediately after start cancels a queued read before it enters a closing store", async () => {
  let reads = 0;
  const sampler = createOutboxBacklogSampler({ metrics: createOutboxMetrics(), refreshIntervalMs: 1000, timeoutMs: 50,
    read: () => { reads += 1; return snapshot; } });
  sampler.start(); sampler.close();
  await setImmediate();
  assert.equal(reads, 0);
  assert.match(sampler.renderMetrics(), /^notification_worker_backlog_available 0$/m);
});
