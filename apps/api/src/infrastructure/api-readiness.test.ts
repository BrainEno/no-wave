import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createApiReadiness } from "./api-readiness.ts";

const env = { AUTH_JWT_SECRET: "fixture-readiness-secret-with-at-least-32-bytes", AUTH_JWT_ISSUER: "https://readiness.example.test",
  AUTH_JWT_AUDIENCE: "readiness", API_READINESS_TIMEOUT_MS: "30", API_READINESS_CACHE_MS: "1000", API_OUTBOX_MAX_PENDING_AGE_MS: "2000" };
const empty = () => ({ pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 });

test("concurrent probes coalesce dependency reads and never launch replacement queries while a timed-out driver is still pending", async () => {
  let healthReads = 0, backlogReads = 0;
  let finish!: (value: boolean) => void;
  const state = createApiReadiness({ env, services: { health: () => { healthReads += 1; return new Promise<boolean>(resolve => { finish = resolve; }); },
    outboxBacklog: () => { backlogReads += 1; return empty(); } } });
  const results = await Promise.all(Array.from({ length: 20 }, () => state.read()));
  assert.ok(results.every(row => row.status === "not_ready" && row.persistence === "unavailable"));
  assert.equal(healthReads, 1);
  assert.equal(backlogReads, 1);
  await state.read();
  const metrics = await state.renderMetrics();
  assert.match(metrics, /^api_readiness_inflight_reads 1$/m);
  assert.match(metrics, /^api_readiness_dependency_failures_total 1$/m);
  assert.equal(healthReads, 1);
  assert.equal(backlogReads, 1);
  finish(true);
  await setImmediate();
  assert.equal((await state.read()).status, "not_ready", "a timed-out read cannot grant readiness when it eventually resolves");
  assert.equal(healthReads, 1);
  state.close();
});

test("a false dependency health result cannot advertise successful persistence", async () => {
  const state = createApiReadiness({ env, services: { health: () => false, outboxBacklog: empty } });
  const result = await state.read();
  assert.equal(result.status, "not_ready");
  assert.equal(result.persistence, "unavailable");
  state.close();
});

test("cached backlog age advances through the readiness threshold and dead letters remain independently visible", async () => {
  let current = 100_000;
  const state = createApiReadiness({ env: { ...env, API_READINESS_CACHE_MS: "10000" }, now: () => current,
    services: { health: () => true, outboxBacklog: () => ({ pendingEvents: 1, deadLetterEvents: 7, oldestPendingAgeMs: 1900 }) } });
  assert.equal((await state.read()).status, "ready");
  current += 101;
  const old = await state.read();
  assert.equal(old.status, "not_ready");
  assert.equal(old.notifications.status, "backlogged");
  assert.equal(old.notifications.oldestPendingAgeMs, 2001);
  assert.equal(old.notifications.deadLetterEvents, 7);
  const metrics = await state.renderMetrics();
  assert.match(metrics, /^api_notification_dead_letter_events 7$/m);
  assert.match(metrics, /^api_notification_oldest_pending_age_seconds 2\.001$/m);
  const deadOnly = createApiReadiness({ env, services: { health: () => true, outboxBacklog: () => ({ ...empty(), deadLetterEvents: 8 }) } });
  assert.equal((await deadOnly.read()).status, "ready");
  state.close(); deadOnly.close();
});

test("failed refreshes retain last-known gauges but fail closed without disclosing exceptions or credentials", async () => {
  let current = 50_000, broken = false;
  const state = createApiReadiness({ env, now: () => current, services: { health: () => true,
    outboxBacklog: () => { if (broken) throw new Error("private-payload postgres://user:credential@database/secret");
      return { pendingEvents: 3, deadLetterEvents: 2, oldestPendingAgeMs: 500 }; } } });
  assert.equal((await state.read()).status, "ready");
  broken = true; current += 1001;
  const failed = await state.read();
  assert.equal(failed.status, "not_ready");
  assert.equal(failed.notifications.status, "unavailable");
  assert.equal(failed.notifications.pendingEvents, 3);
  assert.equal(failed.notifications.oldestPendingAgeMs, 1501);
  const metrics = await state.renderMetrics();
  assert.match(metrics, /^api_notification_backlog_available 0$/m);
  assert.match(metrics, /^api_notification_pending_events 3$/m);
  assert.match(metrics, /^api_readiness_dependency_failures_total 1$/m);
  assert.doesNotMatch(JSON.stringify(failed) + metrics, /private-payload|credential|postgres:\/\//);
  broken = false; current += 1001;
  assert.equal((await state.read()).status, "ready");
  state.close();
});

test("invalid backlog values are unavailable, not coerced to an empty healthy queue", async () => {
  for (const invalid of [null, {}, { ...empty(), pendingEvents: "0" }, { ...empty(), deadLetterEvents: -1 },
    { ...empty(), oldestPendingAgeMs: NaN }, { ...empty(), pendingEvents: Number.MAX_SAFE_INTEGER + 1 }, { ...empty(), oldestPendingAgeMs: 1 }]) {
    const state = createApiReadiness({ env, services: { health: () => true, outboxBacklog: () => invalid } });
    const result = await state.read();
    assert.equal(result.status, "not_ready");
    assert.equal(result.notifications.status, "unavailable");
    assert.equal(result.notifications.pendingEvents, null);
    state.close();
  }
});

test("closing readiness invalidates in-flight completions and prevents any later dependency reads", async () => {
  let resolveHealth!: (value: boolean) => void;
  let resolveBacklog!: (value: ReturnType<typeof empty>) => void;
  let reads = 0;
  const state = createApiReadiness({ env, services: { health: () => { reads += 1; return new Promise(resolve => { resolveHealth = resolve; }); },
    outboxBacklog: () => { reads += 1; return new Promise(resolve => { resolveBacklog = resolve; }); } } });
  const reading = state.read();
  await setImmediate();
  state.close(); resolveHealth(true); resolveBacklog(empty());
  assert.equal((await reading).status, "not_ready");
  const later = await state.read();
  assert.equal(later.notifications.pendingEvents, null);
  assert.equal(later.persistence, "unavailable");
  assert.equal(reads, 2);
});

test("late backlog reads preserve the last trusted sample and recovery requires a new timely read", async () => {
  let current = 100;
  let finish!: (value: ReturnType<typeof empty>) => void;
  let backlogReads = 0;
  const state = createApiReadiness({ env: { ...env, API_READINESS_CACHE_MS: "10" }, now: () => current,
    wallNow: () => 1_700_000_000_000 + current,
    services: { health: () => true, outboxBacklog: () => {
      backlogReads += 1;
      if (backlogReads === 2) return new Promise(resolve => { finish = resolve; });
      return { pendingEvents: 2, deadLetterEvents: 1, oldestPendingAgeMs: 500 };
    } } });
  try {
    const first = await state.read();
    assert.equal(first.status, "ready");
    current += 11;
    const delayed = state.read(); await setImmediate();
    current += 31;
    finish(empty());
    const late = await delayed;
    assert.equal(late.status, "not_ready");
    assert.equal(late.notifications.status, "unavailable");
    assert.equal(late.notifications.pendingEvents, 2);
    assert.equal(late.notifications.sampledAt, first.notifications.sampledAt);
    assert.equal(late.notifications.oldestPendingAgeMs, 542);
    assert.match(await state.renderMetrics(), /^api_readiness_dependency_failures_total 1$/m);
    assert.equal(backlogReads, 2, "do not retry before the settled failure's cache budget");
    current += 11;
    const recovered = await state.read();
    assert.equal(recovered.status, "ready");
    assert.equal(backlogReads, 3);
    assert.notEqual(recovered.notifications.sampledAt, first.notifications.sampledAt);
  } finally { state.close(); }
});

test("closing readiness releases all pending HTTP probes immediately even if both driver reads never settle", async () => {
  let reads = 0;
  const state = createApiReadiness({ env: { ...env, API_READINESS_TIMEOUT_MS: "5000" }, services: {
    health: () => { reads += 1; return new Promise(() => {}); },
    outboxBacklog: () => { reads += 1; return new Promise(() => {}); },
  } });
  const probes = Promise.all(Array.from({ length: 8 }, () => state.read()));
  await setImmediate();
  const started = performance.now();
  state.close(); state.close();
  const result = await Promise.race([probes, new Promise<null>(resolve => setTimeout(() => resolve(null), 200))]);
  assert.ok(result, "shutdown must not spend its drain budget waiting for readiness-only work");
  assert.ok(result.every(status => status.status === "not_ready" && status.notifications.status === "unavailable"));
  assert.ok(performance.now() - started < 180);
  assert.equal(reads, 2);
  assert.equal((await state.read()).status, "not_ready");
  assert.equal(reads, 2);
});

test("shutdown before the read microtask runs cannot start a query against a closing persistence pool", async () => {
  let reads = 0;
  const state = createApiReadiness({ env, services: {
    health: () => { reads += 1; return true; }, outboxBacklog: () => { reads += 1; return empty(); },
  } });
  const pending = state.read();
  state.close();
  assert.equal((await pending).status, "not_ready");
  await setImmediate();
  assert.equal(reads, 0);
});
