import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { StoredOutboxEvent } from "../application/persistence-ports.ts";
import { outboxRetryDelaySeconds, resolveOutboxRetryPolicy } from "./outbox-retry-policy.ts";
import { dispatchOutboxBatch, type DispatchOutboxBatchInput, type OutboxDeliveryFailure } from "./outbox-worker.ts";
import { runOutboxDrain } from "./outbox-drain.ts";

type Store = DispatchOutboxBatchInput["store"];
function event(attempts: number): StoredOutboxEvent {
  return { id: randomUUID(), event_key: "message:retry-policy", event_type: "message.created", aggregate_id: "message-id",
    payload: { body: "private-body" }, attempts, available_at: "2099-01-01T00:00:00.000Z", lease_token: randomUUID() };
}
function stub(attempts: number, settlement: boolean | Error = true) {
  let handedOut = false;
  const claims: unknown[] = [], transitions: unknown[] = [];
  const item = event(attempts);
  const store: Store = {
    async claimOutboxEvents(input) { claims.push(input); if (handedOut) return []; handedOut = true; return [item]; },
    async markOutboxDelivered() { return true; },
    async rescheduleOutboxEvent(input) { transitions.push(input); if (settlement instanceof Error) throw settlement; return settlement; },
  };
  return { store, item, claims, transitions };
}

test("the default retry policy is finite, exponential and capped, never an immediate spin", () => {
  const policy = resolveOutboxRetryPolicy();
  assert.deepEqual(policy, { retryDelaySeconds: 30, maxRetryDelaySeconds: 86400, maxAttempts: 8 });
  assert.deepEqual(Array.from({ length: 9 }, (_, index) => outboxRetryDelaySeconds(index + 1, policy)), [30, 60, 120, 240, 480, 960, 1920, null, null]);
  const capped = resolveOutboxRetryPolicy({ retryDelaySeconds: 50, maxRetryDelaySeconds: 100, maxAttempts: 100 });
  assert.deepEqual([1, 2, 3, 99, 100].map(attempt => outboxRetryDelaySeconds(attempt, capped)), [50, 100, 100, 100, null]);
  assert.equal(outboxRetryDelaySeconds(Number.MAX_SAFE_INTEGER, capped), null, "large historical counts must not overflow a backoff computation");
  const once = resolveOutboxRetryPolicy({ maxAttempts: 1 });
  assert.equal(outboxRetryDelaySeconds(1, once), null, "the first claimed delivery counts as an attempt");
});

test("retry-policy validation refuses unbounded, fractional and inconsistent settings", () => {
  for (const invalid of [
    { maxAttempts: 0 }, { maxAttempts: 101 }, { maxAttempts: NaN }, { maxAttempts: Infinity }, { maxAttempts: 1.5 },
    { retryDelaySeconds: 0 }, { retryDelaySeconds: 86401 }, { retryDelaySeconds: 1.5 },
    { maxRetryDelaySeconds: 0 }, { maxRetryDelaySeconds: 86401 }, { maxRetryDelaySeconds: Infinity },
    { retryDelaySeconds: 31, maxRetryDelaySeconds: 30 },
  ]) assert.throws(() => resolveOutboxRetryPolicy(invalid), TypeError);
  for (const attempts of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => outboxRetryDelaySeconds(attempts, resolveOutboxRetryPolicy()), TypeError);
  }
});

test("dispatch and bounded drain reject retry-policy errors before claiming any row", async () => {
  for (const invalid of [{ maxAttempts: 0 }, { maxAttempts: 101 }, { maxRetryDelaySeconds: 0 }, { maxRetryDelaySeconds: 29 }]) {
    const f = stub(1);
    await assert.rejects(dispatchOutboxBatch({ store: f.store, deliver: async () => {}, ...invalid }), TypeError);
    await assert.rejects(runOutboxDrain({ store: f.store, deliver: async () => {}, ...invalid }), TypeError);
    assert.deepEqual(f.claims, []);
    assert.deepEqual(f.transitions, []);
  }
});

test("a worker passes the same attempt budget to claim and the fenced retry transition", async () => {
  const f = stub(3), failures: OutboxDeliveryFailure[] = [];
  const result = await dispatchOutboxBatch({
    store: f.store, deliver: async () => { throw new RangeError("private-body"); }, limit: 1,
    leaseSeconds: 45, retryDelaySeconds: 7, maxRetryDelaySeconds: 20, maxAttempts: 5,
    onDeliveryFailure: failure => { failures.push(failure); },
  });
  assert.deepEqual(f.claims, [{ limit: 1, leaseSeconds: 45, maxAttempts: 5 }]);
  assert.deepEqual(f.transitions, [{ eventId: f.item.id, leaseToken: f.item.lease_token, delaySeconds: 20, maxAttempts: 5 }]);
  assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1, deadLettered: 0 });
  assert.deepEqual(failures, [{ eventId: f.item.id, eventType: "message.created", attempts: 3, errorName: "RangeError",
    retryScheduled: true, deadLettered: false, retryDelaySeconds: 20, retryScheduleErrorName: null }]);
  assert.ok(!JSON.stringify(failures).includes("private-body"));
});

test("a terminal transition is reported separately from a scheduled retry", async () => {
  const f = stub(4), failures: OutboxDeliveryFailure[] = [];
  const result = await runOutboxDrain({
    store: f.store, deliver: async () => { throw new Error("private error"); },
    maxAttempts: 4, retryDelaySeconds: 2, maxRetryDelaySeconds: 8,
    onDeliveryFailure: failure => { failures.push(failure); },
  });
  assert.equal(result.deadLettered, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.stopReason, "empty");
  assert.deepEqual(f.transitions, [{ eventId: f.item.id, leaseToken: f.item.lease_token, delaySeconds: 2, maxAttempts: 4 }]);
  assert.equal(failures[0].deadLettered, true);
  assert.equal(failures[0].retryScheduled, false);
  assert.equal(failures[0].retryDelaySeconds, null);
  assert.equal(failures[0].retryScheduleErrorName, null);
});

test("a lost lease cannot be reported as a successful retry or dead-letter transition", async () => {
  for (const attempts of [1, 8]) {
    const f = stub(attempts, false), failures: OutboxDeliveryFailure[] = [];
    const result = await dispatchOutboxBatch({
      store: f.store, deliver: async () => { throw new Error("lost"); },
      onDeliveryFailure: failure => { failures.push(failure); },
    });
    assert.deepEqual(result, { claimed: 1, delivered: 0, failed: 1, deadLettered: 0 });
    assert.equal(failures[0].retryScheduled, false);
    assert.equal(failures[0].deadLettered, false);
    assert.equal(failures[0].retryDelaySeconds, null);
  }
});

test("database errors during retry or quarantine are surfaced after safe observer diagnostics", async () => {
  for (const attempts of [1, 8]) {
    const databaseError = new TypeError("database password and SQL must not appear");
    const f = stub(attempts, databaseError), failures: OutboxDeliveryFailure[] = [];
    await assert.rejects(dispatchOutboxBatch({
      store: f.store, deliver: async () => { throw new RangeError("secret payload"); },
      onDeliveryFailure: failure => { failures.push(failure); },
    }), error => error === databaseError);
    assert.equal(failures[0].errorName, "RangeError");
    assert.equal(failures[0].retryScheduleErrorName, "TypeError");
    assert.equal(failures[0].retryScheduled, false);
    assert.equal(failures[0].deadLettered, false);
    assert.doesNotMatch(JSON.stringify(failures), /password|secret|SQL/);
  }
});

test("observer errors cannot prevent a terminal state and hostile error names are redacted", async () => {
  const f = stub(8);
  const hostile = new Error("private");
  hostile.name = "Error\nAuthorization: do-not-log";
  let observed: OutboxDeliveryFailure | undefined;
  const result = await dispatchOutboxBatch({
    store: f.store, deliver: async () => { throw hostile; },
    onDeliveryFailure: failure => { observed = failure; throw new Error("broken logger"); },
  });
  assert.equal(result.deadLettered, 1);
  assert.equal(observed!.errorName, "Error");
  assert.equal(observed!.deadLettered, true);
  const other = stub(1), diagnostics: OutboxDeliveryFailure[] = [];
  await dispatchOutboxBatch({ store: other.store, deliver: async () => { throw "private non-error"; },
    onDeliveryFailure: failure => { diagnostics.push(failure); } });
  assert.equal(diagnostics[0].errorName, "NonErrorThrow");
  assert.ok(!JSON.stringify(diagnostics).includes("private"));
});

test("the final allowed attempt can still succeed and never gets quarantined eagerly", async () => {
  const f = stub(8);
  const result = await dispatchOutboxBatch({ store: f.store, deliver: async () => {} });
  assert.deepEqual(result, { claimed: 1, delivered: 1, failed: 0, deadLettered: 0 });
  assert.deepEqual(f.transitions, []);
});
