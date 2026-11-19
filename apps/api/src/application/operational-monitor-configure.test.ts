import assert from "node:assert/strict";
import test from "node:test";
import { parseMonitorConfig } from "../infrastructure/monitor-config.ts";
import { evaluateMonitor, acknowledgeMonitorEvents } from "./operational-alerts.ts";
import { reconfigureMonitor } from "./operational-monitor-configure.ts";
import type { MonitorConfig, MonitorState } from "./operational-monitor.ts";

const start = 1_800_000_000_000;
const target = { id: "api-one", role: "api", metricsUrl: "http://127.0.0.1:4000/metrics" };
const config = (overrides: Record<string, unknown> = {}) => parseMonitorConfig({ version: 1, targets: [target], policy: { windowMs: 1000 }, rules: { database_unavailable: { forMs: 0, resolveMs: 2000 } }, ...overrides });
function check(c: MonitorConfig, state: MonitorState | null, at: number, databaseAvailable = true) {
  return evaluateMonitor(c, state, [{ targetId: "api-one", observedAt: at, reason: "ok", snapshot: { instance: "ac46e942-b319-4cd3-9f39-cbfc3db4bb69", ready: true, databaseAvailable,
    http: { requests: at - start + 100, errors: 0 }, mailFailures: 0, backlog: { pending: 0, deadLetters: 0, oldestAgeSeconds: 0 } } }], at).state;
}
const dbRule = (state: MonitorState) => state.targets[0].rules.find(rule => rule.id === "database_unavailable")!;

test("adding an explicit target preserves existing counters, phases and observation timestamps", () => {
  const old = config(); const state = check(old, null, start);
  const next = config({ targets: [target, { id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" }] });
  const result = reconfigureMonitor(old, next, state, start + 1000);
  assert.deepEqual(result.state.targets[0], { ...state.targets[0], lastObservation: null });
  assert.deepEqual(result.added, ["worker-one"]); assert.deepEqual(result.removed, []);
  assert.equal(result.state.targets[1].lastSampleAt, null);
  assert.equal(result.state.lastEvaluatedAt, start, "changing configuration is not a new healthy observation");
  assert.equal(result.state.revision, state.revision + 1);
  assert.equal(result.state.lastConfigurationChange?.fromFingerprint, old.fingerprint);
  assert.equal(result.state.lastConfigurationChange?.at, start + 1000);
  assert.doesNotMatch(JSON.stringify(result), /metricsUrl|127\.0\.0\.1|\/metrics/);
});

test("unacknowledged receipts cannot be silently discarded by a configuration change", () => {
  const old = config(), next = config({ policy: { httpErrorRatio: 0.2 } });
  const state = check(old, null, start, false), previous = JSON.stringify(state);
  assert.throws(() => reconfigureMonitor(old, next, state, start + 1000), { code: "config_pending_events" });
  assert.equal(JSON.stringify(state), previous);
});

test("an active target cannot be removed, renamed, changed to another role or pointed at a different process", () => {
  const old = config(), fired = check(old, null, start, false);
  const state = acknowledgeMonitorEvents(old, fired, fired.events[0].id).state;
  for (const targets of [[{ ...target, id: "api-renamed" }], [{ ...target, metricsUrl: "http://127.0.0.1:4001/metrics" }], [{ ...target, role: "notification-worker" }]]) {
    assert.throws(() => reconfigureMonitor(old, config({ targets }), state, start + 1000), { code: "config_active_targets" });
  }
});

test("a changed threshold/timing restarts continuity, never clears an acknowledged firing condition", () => {
  const old = config(); const fired = check(old, null, start, false);
  const acknowledged = acknowledgeMonitorEvents(old, fired, fired.events[0].id).state;
  const next = config({ rules: { database_unavailable: { forMs: 5000, resolveMs: 5000 } } });
  const result = reconfigureMonitor(old, next, acknowledged, start + 1000);
  assert.equal(dbRule(result.state).phase, "firing");
  assert.equal(dbRule(result.state).firingSince, dbRule(acknowledged).firingSince);
  assert.equal(result.state.events.length, 0);
  assert.ok(result.rulesReset.some(row => row.targetId === "api-one" && row.rule === "database_unavailable"));
});

test("pending and recovering durations cannot be carried into a materially different rule", () => {
  const old = config({ rules: { database_unavailable: { forMs: 2000, resolveMs: 2000 } } });
  const pending = check(old, null, start, false);
  const next = config({ rules: { database_unavailable: { forMs: 1000, resolveMs: 5000 } } });
  const first = reconfigureMonitor(old, next, pending, start + 1000);
  assert.equal(dbRule(first.state).phase, "inactive"); assert.equal(dbRule(first.state).pendingSince, null);
  const immediate = config(); const fired = check(immediate, null, start, false);
  const acknowledged = acknowledgeMonitorEvents(immediate, fired, fired.events[0].id).state;
  const recovering = check(immediate, acknowledged, start + 1000, true);
  assert.equal(dbRule(recovering).phase, "recovering");
  const second = reconfigureMonitor(immediate, next, recovering, start + 2000);
  assert.equal(dbRule(second.state).phase, "firing"); assert.equal(dbRule(second.state).recoverySince, null);
});

test("shortening or extending a counter window preserves only its last trusted baseline", () => {
  const old = config(); let state = check(old, null, start); state = check(old, state, start + 1000);
  assert.equal(state.targets[0].history.length, 2);
  const next = config({ policy: { windowMs: 5000 } });
  const result = reconfigureMonitor(old, next, state, start + 2000);
  assert.deepEqual(result.state.targets[0].history, state.targets[0].history.slice(-1));
  assert.equal(result.state.targets[0].lastSampleAt, state.targets[0].lastSampleAt);
  assert.ok(result.rulesReset.some(row => row.rule === "http_5xx"));
});

test("inactive targets may be deliberately retired or rebound, with no fabricated resolved event", () => {
  const old = config(), state = check(old, null, start);
  const changed = config({ targets: [{ ...target, metricsUrl: "http://127.0.0.1:4001/metrics" }] });
  const rebound = reconfigureMonitor(old, changed, state, start + 1000);
  assert.deepEqual(rebound.sourcesReset, ["api-one"]); assert.equal(rebound.state.targets[0].instance, null);
  const replacement = config({ targets: [{ ...target, id: "replacement-api" }] });
  const retired = reconfigureMonitor(old, replacement, state, start + 1000);
  assert.deepEqual(retired.removed, ["api-one"]); assert.deepEqual(retired.added, ["replacement-api"]);
  assert.equal(retired.state.events.length, 0);
});

test("identical configuration is an idempotent no-op, but rollback of the configuration clock fails", () => {
  const old = config(), state = check(old, null, start);
  const same = reconfigureMonitor(old, config(), state, start + 1000);
  assert.equal(same.changed, false); assert.deepEqual(same.state, state);
  const next = config({ policy: { mailFailures: 2 } });
  const migrated = reconfigureMonitor(old, next, state, start + 2000);
  assert.throws(() => reconfigureMonitor(next, old, migrated.state, start + 1000), { code: "clock_rollback" });
  assert.throws(() => check(next, migrated.state, start + 1000), { code: "clock_rollback" });
});
