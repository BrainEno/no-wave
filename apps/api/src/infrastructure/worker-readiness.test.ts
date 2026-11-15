import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createWorkerReadiness } from "./worker-readiness.ts";
import { createWorkerHealth } from "./worker-health.ts";

const empty = { claimed: 0, delivered: 0, failed: 0, deadLettered: 0 };

test("worker readiness requires durable batch progress and distinguishes startup, failures, recovery and termination", () => {
  let current = 0;
  const state = createWorkerReadiness({ pollIntervalMs: 100, leaseSeconds: 1, now: () => current, wallNow: () => 1_700_000_000_000 });
  assert.equal(state.snapshot().reason, "starting");
  state.beginBatch();
  assert.equal(state.snapshot().phase, "delivering");
  assert.equal(state.snapshot().status, "not_ready");
  assert.throws(() => state.beginBatch(), /overlap/);
  state.finishBatch(empty);
  assert.equal(state.snapshot().status, "ready");
  assert.equal(state.snapshot().lastSuccessAt, "2023-11-14T22:13:20.000Z");
  current += 1001;
  assert.equal(state.snapshot().reason, "stale");
  state.beginBatch(); state.failBatch();
  assert.equal(state.snapshot().reason, "batch_failed");
  assert.equal(state.snapshot().consecutiveFailures, 1);
  state.beginBatch(); state.finishBatch({ claimed: 2, delivered: 1, failed: 1, deadLettered: 1 });
  assert.equal(state.snapshot().status, "ready", "a settled poison event is separate from a batch-level database failure");
  assert.equal(state.snapshot().consecutiveFailures, 0);
  assert.equal(state.snapshot().completedBatches, 2);
  state.beginBatch(); state.stopping(); state.finishBatch(empty);
  assert.equal(state.snapshot().phase, "stopping");
  assert.equal(state.snapshot().status, "not_ready");
  assert.throws(() => state.beginBatch(), /stopping/);
  state.stopped(); state.stopping();
  assert.equal(state.snapshot().reason, "stopped");
  assert.throws(() => state.finishBatch(empty));
});

test("a hanging batch becomes unready from monotonic age even if wall time moves backwards", () => {
  let current = 2000, wall = 1_700_000_000_000;
  const state = createWorkerReadiness({ pollIntervalMs: 100, leaseSeconds: 2, now: () => current, wallNow: () => wall });
  state.beginBatch(); state.finishBatch(empty);
  state.beginBatch();
  current += 1999; wall -= 86_400_000;
  assert.equal(state.snapshot().status, "ready");
  current += 2;
  assert.equal(state.snapshot().reason, "batch_overdue");
  assert.equal(state.snapshot().batchAgeMs, 2001);
  assert.match(state.renderMetrics(), /^notification_worker_ready 0$/m);
  assert.match(state.renderMetrics(), /^notification_worker_phase\{phase="delivering"\} 1$/m);
  assert.match(state.renderMetrics(), /^notification_worker_inflight_batch_age_seconds 2\.001$/m);
  state.finishBatch(empty);
  assert.equal(state.snapshot().status, "ready");
});

test("worker progress snapshots are defensive and invalid batch counts cannot fabricate healthy progress", () => {
  const state = createWorkerReadiness({ pollIntervalMs: 1000, leaseSeconds: 60 });
  state.beginBatch();
  for (const invalid of [{ ...empty, claimed: 1 }, { ...empty, failed: -1 }, { claimed: 1, delivered: 0, failed: 1, deadLettered: 2 }]) {
    assert.throws(() => state.finishBatch(invalid), RangeError);
    assert.equal(state.snapshot().completedBatches, 0);
  }
  state.finishBatch({ claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
  state.snapshot().lastBatch!.claimed = 9000;
  assert.equal(state.snapshot().lastBatch!.claimed, 1);
  assert.throws(() => createWorkerReadiness({ pollIntervalMs: 99, leaseSeconds: 60 }));
  assert.throws(() => createWorkerReadiness({ pollIntervalMs: 1000, leaseSeconds: 0 }));
});

test("the independent worker listener has query/HEAD liveness and readiness without reflecting payloads, credentials or URLs", async () => {
  const state = createWorkerReadiness({ pollIntervalMs: 1000, leaseSeconds: 60 });
  const health = createWorkerHealth({ readiness: state, env: { OUTBOX_HEALTH_PORT: "0", AUTH_JWT_SECRET: "private-worker-secret-canary",
    DATABASE_URL: "postgres://private-canary/hidden", SHUTDOWN_GRACE_MS: "300", SHUTDOWN_CLEANUP_MS: "100" } });
  assert.equal(health.server.headersTimeout, 5000);
  const port = await health.listen();
  assert.equal(await health.listen(), port);
  const origin = `http://127.0.0.1:${port}`;
  try {
    const starting = await fetch(origin + "/ready?private-payload-canary");
    assert.equal(starting.status, 503);
    assert.equal(starting.headers.get("retry-after"), "1");
    assert.equal((await starting.json()).reason, "starting");
    state.beginBatch(); state.finishBatch(empty);
    for (const path of ["/health?private-payload-canary", "/ready?private-payload-canary"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control")!, /no-store/);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.doesNotMatch(await response.text(), /private-|postgres:\/\//);
      const head = await fetch(origin + path, { method: "HEAD" });
      assert.equal(head.status, 200); assert.equal(await head.text(), "");
    }
    state.beginBatch(); state.failBatch();
    assert.equal((await fetch(origin + "/ready")).status, 503);
    assert.equal((await fetch(origin + "/health")).status, 200);
    assert.equal((await fetch(origin + "/metrics")).status, 404, "anonymous health does not publish the metrics listener");
    const post = await fetch(origin + "/ready", { method: "POST" });
    assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET, HEAD");
    state.stopping();
    assert.equal((await (await fetch(origin + "/ready")).json()).reason, "stopping");
    const first = health.stop(), repeated = health.stop();
    assert.equal(first, repeated);
    assert.equal((await first).exitCode, 0);
  } finally { await health.stop(); }
});

test("disabled worker health closes without binding, and occupied listeners fail rather than pretending ready", async () => {
  const readiness = createWorkerReadiness({ pollIntervalMs: 1000, leaseSeconds: 60 });
  const disabled = createWorkerHealth({ readiness, env: {} });
  assert.equal(await disabled.listen(), null);
  assert.equal((await disabled.stop()).exitCode, 0);
  const first = createWorkerHealth({ readiness, env: { OUTBOX_HEALTH_PORT: "0" } });
  const port = await first.listen();
  const collision = createWorkerHealth({ readiness, env: { OUTBOX_HEALTH_PORT: String(port) } });
  try { await assert.rejects(collision.listen(), { code: "EADDRINUSE" }); }
  finally { await Promise.all([first.stop(), collision.stop()]); }
  assert.equal(first.server.listening, false);
  assert.equal(collision.server.listening, false);
  const delayed = createWorkerHealth({ readiness, env: { OUTBOX_HEALTH_PORT: "0" } });
  await delayed.stop();
  const closed = once(delayed.server, "close");
  await assert.rejects(delayed.listen(), /listener/);
  await closed;
  assert.equal(delayed.server.listening, false, "late startup cannot resurrect a stopped health server");
});
