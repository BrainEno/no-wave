import assert from "node:assert/strict";
import test from "node:test";
import { parseMonitorConfig } from "../infrastructure/monitor-config.ts";
import { evaluateMonitor, acknowledgeMonitorEvents } from "./operational-alerts.ts";
import { parseMonitorState } from "./operational-monitor-state.ts";
import { MONITOR_RULES, type MonitorConfig, type MonitorObservation, type MonitorSnapshot, type MonitorState } from "./operational-monitor.ts";

const firstAt = 1_800_000_000_000;
const instance = "c5a26d0b-bd2f-45e4-a40c-c534fedc717c";
function config(extra: Record<string, unknown> = {}): MonitorConfig {
  return parseMonitorConfig({ version: 1, targets: [{ id: "api-one", role: "api", metricsUrl: "http://127.0.0.1:4000/metrics" }],
    policy: { windowMs: 2000, minIntervalMs: 1000, maxGapMs: 5000, httpMinRequests: 1 },
    rules: Object.fromEntries(MONITOR_RULES.map(id => [id, { forMs: 2000, resolveMs: 2000, repeatMs: 30_000 }])), ...extra });
}
function observation(at: number, change: Partial<MonitorSnapshot> = {}): MonitorObservation {
  return { targetId: "api-one", reason: "ok", observedAt: at, snapshot: { instance, ready: true, databaseAvailable: true,
    backlog: { pending: 0, deadLetters: 0, oldestAgeSeconds: 0 }, http: { requests: Math.round((at - firstAt) / 1000) + 100, errors: 0 }, mailFailures: 0, ...change } };
}
function check(c: MonitorConfig, state: MonitorState | null, at: number, change: Partial<MonitorSnapshot> = {}) {
  return evaluateMonitor(c, state, [observation(at, change)], at);
}
const row = (result: ReturnType<typeof evaluateMonitor>, id: string) => result.report.targets[0].rules.find(rule => rule.id === id)!;

test("an actual duration, not repeated invocations or old state, promotes pending to firing exactly once", () => {
  const c = config();
  let result = check(c, null, firstAt, { databaseAvailable: false });
  assert.equal(row(result, "database_unavailable").phase, "pending");
  assert.equal(result.state.events.length, 0);
  result = check(c, result.state, firstAt + 1000, { databaseAvailable: false });
  assert.equal(row(result, "database_unavailable").phase, "pending");
  result = check(c, result.state, firstAt + 2000, { databaseAvailable: false });
  assert.equal(row(result, "database_unavailable").phase, "firing");
  assert.equal(result.state.events.filter(event => event.rule === "database_unavailable").length, 1);
  const previous = JSON.stringify(result.state);
  assert.throws(() => check(c, result.state, firstAt + 2000), { code: "sample_too_soon" });
  assert.equal(JSON.stringify(result.state), previous);
});

test("an unknown observation cannot resolve a firing alarm or count towards continuous recovery", () => {
  const c = config({ rules: { database_unavailable: { forMs: 0, resolveMs: 2000 } } });
  let result = check(c, null, firstAt, { databaseAvailable: false });
  result = check(c, result.state, firstAt + 1000);
  assert.equal(row(result, "database_unavailable").phase, "recovering");
  result = evaluateMonitor(c, result.state, [{ targetId: "api-one", reason: "timeout", observedAt: firstAt + 2000, snapshot: null }], firstAt + 2000);
  assert.equal(row(result, "database_unavailable").phase, "firing");
  assert.equal(row(result, "database_unavailable").condition, "unknown");
  result = check(c, result.state, firstAt + 3000);
  assert.equal(row(result, "database_unavailable").phase, "recovering");
  result = check(c, result.state, firstAt + 4000);
  assert.equal(row(result, "database_unavailable").phase, "recovering");
  result = check(c, result.state, firstAt + 5000);
  assert.equal(row(result, "database_unavailable").phase, "inactive");
  assert.equal(result.state.events.filter(event => event.rule === "database_unavailable" && event.transition === "resolved").length, 1);
});

test("5xx uses per-instance observed deltas, minimum traffic and complete windows", () => {
  const c = config({ rules: { http_5xx: { forMs: 0, resolveMs: 0 } } });
  let result = check(c, null, firstAt, { http: { requests: 1000, errors: 100 } });
  assert.equal(row(result, "http_5xx").reason, "counter_warmup");
  result = check(c, result.state, firstAt + 1000, { http: { requests: 1100, errors: 100 } });
  result = check(c, result.state, firstAt + 2000, { http: { requests: 1200, errors: 120 } });
  assert.equal(row(result, "http_5xx").phase, "firing");
  assert.equal(row(result, "http_5xx").value, 0.1);
  const replacement = "f17b2cf0-b80b-41de-831a-a3ea9a7904f8";
  result = check(c, result.state, firstAt + 3000, { instance: replacement, http: { requests: 3000, errors: 0 } });
  assert.equal(row(result, "http_5xx").condition, "unknown", "even a higher restart counter is not continuous");
  assert.equal(row(result, "http_5xx").phase, "firing");
  result = check(c, result.state, firstAt + 4000, { instance: replacement, http: { requests: 3000, errors: 0 } });
  result = check(c, result.state, firstAt + 5000, { instance: replacement, http: { requests: 3000, errors: 0 } });
  assert.equal(row(result, "http_5xx").reason, "insufficient_traffic");
  assert.equal(row(result, "http_5xx").phase, "firing", "a quiet site is not evidence that the 5xx path recovered");
});

test("counter decreases and long monitor gaps restart warm-up without fabricated recovery", () => {
  const c = config({ rules: { http_5xx: { forMs: 0, resolveMs: 0 }, database_unavailable: { forMs: 2000 } } });
  let result = check(c, null, firstAt, { databaseAvailable: false, http: { requests: 100, errors: 0 } });
  result = check(c, result.state, firstAt + 1000, { databaseAvailable: false, http: { requests: 200, errors: 20 } });
  result = check(c, result.state, firstAt + 2000, { databaseAvailable: false, http: { requests: 300, errors: 40 } });
  assert.equal(row(result, "http_5xx").phase, "firing");
  result = check(c, result.state, firstAt + 3000, { http: { requests: 10, errors: 0 } });
  assert.equal(row(result, "http_5xx").reason, "counter_reset");
  assert.equal(row(result, "http_5xx").phase, "firing");
  result = check(c, result.state, firstAt + 20_000, { http: { requests: 20, errors: 0 } });
  assert.equal(row(result, "database_unavailable").phase, "recovering", "a missing 17 seconds cannot prove healthy continuity");
  assert.equal(row(result, "http_5xx").condition, "unknown");
});

test("unavailable backlog telemetry cannot clear a last-known dead letter", () => {
  const c = config({ rules: { notification_dead_letters: { forMs: 0, resolveMs: 0 } } });
  let result = check(c, null, firstAt, { backlog: { pending: 0, oldestAgeSeconds: 0, deadLetters: 1 } });
  assert.equal(row(result, "notification_dead_letters").phase, "firing");
  result = check(c, result.state, firstAt + 1000, { backlog: null });
  assert.equal(row(result, "notification_dead_letters").phase, "firing");
  assert.equal(row(result, "notification_dead_letters").condition, "unknown");
  assert.equal(row(result, "notification_telemetry_unavailable").condition, "bad");
  result = check(c, result.state, firstAt + 2000);
  assert.equal(row(result, "notification_dead_letters").phase, "inactive");
});

test("mail failures are a windowed failure count, not a denominator diluted by skipped mail", () => {
  const c = config({ rules: { mail_delivery_failures: { forMs: 0, resolveMs: 0 } } });
  let result = check(c, null, firstAt, { mailFailures: 10 });
  result = check(c, result.state, firstAt + 1000, { mailFailures: 10 });
  result = check(c, result.state, firstAt + 2000, { mailFailures: 11 });
  assert.equal(row(result, "mail_delivery_failures").phase, "firing");
  assert.equal(row(result, "mail_delivery_failures").value, 1);
  result = check(c, result.state, firstAt + 3000, { mailFailures: 11 });
  result = check(c, result.state, firstAt + 4000, { mailFailures: 11 });
  assert.equal(row(result, "mail_delivery_failures").phase, "inactive");
});

test("events survive output loss and acknowledgements only remove an exact, durable prefix", () => {
  const c = config({ rules: { database_unavailable: { forMs: 0, resolveMs: 0 } } });
  const fired = check(c, null, firstAt, { databaseAvailable: false });
  const resolved = check(c, fired.state, firstAt + 1000);
  assert.equal(resolved.state.events.length, 2);
  assert.equal(resolved.state.events[0].id, fired.state.events[0].id);
  assert.equal(resolved.report.unacknowledged, 2);
  assert.equal(resolved.report.exitCode, 1);
  const receipt = fired.state.events[0].id;
  const ack = acknowledgeMonitorEvents(c, resolved.state, receipt);
  assert.equal(ack.acknowledged, 1);
  assert.equal(ack.state.events.length, 1);
  assert.equal(ack.state.targets[0].rules.find(rule => rule.id === "database_unavailable")?.phase, "inactive");
  assert.deepEqual(acknowledgeMonitorEvents(c, ack.state, receipt).state, ack.state, "a lost ack response can be retried without losing a later event");
  assert.throws(() => acknowledgeMonitorEvents(c, ack.state, "a".repeat(64)), { code: "event_not_found" });
  assert.equal(resolved.state.events.length, 2, "pure evaluation and ack do not mutate caller-owned state");
});

test("reminders are rate-limited and do not replace unacknowledged transitions", () => {
  const c = config({ policy: { windowMs: 2000, minIntervalMs: 1000, maxGapMs: 60_000 }, rules: { database_unavailable: { forMs: 0, repeatMs: 30_000 } } });
  let result = check(c, null, firstAt, { databaseAvailable: false });
  const original = result.state.events[0].id;
  result = check(c, result.state, firstAt + 29_000, { databaseAvailable: false });
  assert.equal(result.state.events.filter(event => event.rule === "database_unavailable").length, 1);
  result = check(c, result.state, firstAt + 30_000, { databaseAvailable: false });
  assert.equal(result.state.events.filter(event => event.rule === "database_unavailable").length, 2);
  assert.equal(result.state.events[0].id, original);
  assert.equal(result.state.events.at(-1)?.transition, "reminder");
});

test("clock rollback, destination changes and ambiguous observation sets never rewrite old state", () => {
  const c = config();
  const original = check(c, null, firstAt).state;
  assert.throws(() => check(c, original, firstAt - 1), { code: "clock_rollback" });
  assert.throws(() => check(config({ policy: { httpErrorRatio: 0.2 } }), original, firstAt + 1000), { code: "state_config_mismatch" });
  assert.throws(() => evaluateMonitor(c, original, [], firstAt + 1000), { code: "invalid_metrics" });
  assert.throws(() => evaluateMonitor(c, original, [observation(firstAt + 1000), observation(firstAt + 1000)], firstAt + 1000), { code: "invalid_metrics" });
  assert.throws(() => check(c, original, firstAt + 1000, { http: { requests: 1, errors: 2 } }), { code: "invalid_metrics" });
  assert.throws(() => evaluateMonitor(c, { ...original, token: "not-allowed" }, [observation(firstAt + 1000)], firstAt + 1000), { code: "state_invalid" });
});

test("re-evaluating a restored older journal cannot reuse a different incident's delivery identity", () => {
  const c = config({ rules: { database_unavailable: { forMs: 0, resolveMs: 0 } } });
  const before = check(c, null, firstAt).state;
  const earlier = check(c, before, firstAt + 1000, { databaseAvailable: false });
  const later = check(c, before, firstAt + 2000, { databaseAvailable: false });
  assert.notEqual(earlier.state.events[0].id, later.state.events[0].id);
});

test("a full durable delivery queue fails closed rather than dropping an alert", () => {
  const c = config({ rules: { database_unavailable: { forMs: 0, resolveMs: 0 } } });
  let state: MonitorState | null = null;
  let failure = false;
  for (let i = 0; i < 280; i++) {
    const before = JSON.stringify(state);
    try { state = check(c, state, firstAt + i * 1000, { databaseAvailable: i % 2 === 0 ? false : true }).state; }
    catch (error) { assert.equal((error as { code: string }).code, "state_full"); assert.equal(JSON.stringify(state), before); failure = true; break; }
  }
  assert.equal(failure, true);
  assert.equal(state?.events.length, 256);
  const ack = acknowledgeMonitorEvents(c, state!, state!.events.at(-1)!.id);
  assert.equal(ack.state.events.length, 0);
});

test("a restored counter history with impossible per-interval error counts fails before evaluation", () => {
  const c = config();
  const first = check(c, null, firstAt, { http: { requests: 100, errors: 0 } });
  const second = check(c, first.state, firstAt + 1000, { http: { requests: 101, errors: 0 } });
  const corrupt = structuredClone(second.state); corrupt.targets[0].history[1].counters.errors = 5;
  assert.throws(() => parseMonitorState(corrupt, c), { code: "state_invalid" });
  assert.equal(second.state.targets[0].history[1].counters.errors, 0);
});
