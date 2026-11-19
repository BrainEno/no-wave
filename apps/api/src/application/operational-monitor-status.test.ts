import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMonitor, acknowledgeMonitorEvents } from "./operational-alerts.ts";
import { emptyMonitorState, parseMonitorState } from "./operational-monitor-state.ts";
import { reconfigureMonitor } from "./operational-monitor-configure.ts";
import { monitorStatus } from "./operational-monitor-status.ts";
import { parseMonitorConfig } from "../infrastructure/monitor-config.ts";
import type { MonitorConfig, MonitorState } from "./operational-monitor.ts";

const at = 1_800_000_000_000;
const target = { id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" };
const config = parseMonitorConfig({ version: 1, targets: [target], rules: { notification_dead_letters: { forMs: 0, resolveMs: 0 } } });
function check(c: MonitorConfig, previous: MonitorState | null, time: number, deadLetters = 0) {
  return evaluateMonitor(c, previous, [{ targetId: target.id, reason: "ok", observedAt: time, snapshot: {
    instance: "f1a0b35c-307f-4fc7-81f2-5539ca56264b", ready: true, databaseAvailable: null,
    backlog: { pending: 0, oldestAgeSeconds: 0, deadLetters }, http: null, mailFailures: null,
  } }], time).state;
}

test("offline status labels a recent observed verdict and cannot present an expired green result as healthy", () => {
  const state = check(config, null, at), previous = JSON.stringify(state);
  const recent = monitorStatus(config, state, at + 1000);
  assert.equal(recent.exitCode, 0); assert.equal(recent.health, "observed_healthy");
  assert.equal(recent.targets[0].freshness, "fresh"); assert.equal(recent.targets[0].observationAgeMs, 1000);
  const stale = monitorStatus(config, state, at + config.policy.maxGapMs + 1);
  assert.equal(stale.exitCode, 3); assert.equal(stale.health, "unknown");
  assert.equal(stale.targets[0].freshness, "stale");
  assert.ok(stale.targets[0].rules.every(rule => rule.condition === "unknown" && rule.reason === "monitor_stale" && rule.value === null));
  assert.equal(JSON.stringify(state), previous, "status never advances observation time, phases, revision or receipts");
  assert.doesNotMatch(JSON.stringify(stale), /127\.0\.0\.1|metricsUrl|\/metrics/);
});

test("active conditions and undelivered recovery receipts remain attention even when observation goes stale", () => {
  const fired = check(config, null, at, 1);
  const acknowledged = acknowledgeMonitorEvents(config, fired, fired.events[0].id).state;
  const latched = monitorStatus(config, acknowledged, at + 100_000);
  assert.equal(latched.exitCode, 1); assert.equal(latched.health, "attention"); assert.equal(latched.unacknowledged, 0);
  assert.equal(latched.targets[0].rules.find(rule => rule.id === "notification_dead_letters")!.phase, "firing");
  const recovered = check(config, acknowledged, at + 1000);
  assert.equal(monitorStatus(config, recovered, at + 2000).exitCode, 1);
  const cleared = acknowledgeMonitorEvents(config, recovered, recovered.events[0].id).state;
  assert.equal(monitorStatus(config, cleared, at + 2000).exitCode, 0);
});

test("a failed fresh scrape is distinct from absent or stale monitor evidence and retains domain unknowns", () => {
  const state = evaluateMonitor(config, null, [{ targetId: target.id, observedAt: at, reason: "timeout", snapshot: null }], at).state;
  const status = monitorStatus(config, state, at + 1000);
  assert.equal(status.targets[0].freshness, "fresh"); assert.equal(status.targets[0].lastSource, "timeout");
  assert.equal(status.targets[0].rules[0].condition, "bad");
  assert.ok(status.targets[0].rules.slice(1).every(rule => rule.condition === "unknown"));
  const never = monitorStatus(config, emptyMonitorState(config), at);
  assert.equal(never.exitCode, 3); assert.equal(never.targets[0].freshness, "not_observed");
});

test("configuration changes invalidate cached verdicts without clearing existing incident phases or inventing samples", () => {
  const state = check(config, null, at), next = parseMonitorConfig({ version: 1, targets: [target], policy: { pendingEvents: 2 } });
  const migrated = reconfigureMonitor(config, next, state, at + 1000).state;
  const status = monitorStatus(next, migrated, at + 2000);
  assert.equal(status.targets[0].freshness, "configuration_changed"); assert.equal(status.exitCode, 3);
  assert.equal(status.lastEvaluatedAt, at); assert.equal(migrated.targets[0].lastSampleAt, at);
  assert.throws(() => monitorStatus(next, migrated, at + 500), { code: "clock_rollback" });
  assert.throws(() => monitorStatus(next, migrated, Number.NaN), { code: "clock_rollback" });
});

test("corrupt cached source/signal facts cannot become an offline health verdict", () => {
  const state = check(config, null, at);
  for (const mutate of [
    (value: MonitorState) => { value.targets[0].lastObservation!.observedAt = at + 1; },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules[0].value = Number.NaN; },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules[0].condition = "unknown"; },
    (value: MonitorState) => { value.targets[0].lastObservation!.source = "transport"; },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules.reverse(); },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules[1].value = 2; },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules[1].value = 1; },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules.at(-1)!.value = 0.5; },
    (value: MonitorState) => { value.targets[0].lastObservation!.rules.at(-1)!.value = 1; },
    (value: MonitorState) => { Object.assign(value.targets[0].lastObservation!.rules[2], { condition: "bad", reason: "breached", value: 1 }); },
  ]) {
    const corrupt = structuredClone(state); mutate(corrupt);
    assert.throws(() => parseMonitorState(corrupt, config), { code: "state_invalid" });
  }
});

test("cached numeric facts must still agree with the configured thresholds before reporting healthy offline", () => {
  const c = parseMonitorConfig({ version: 1, targets: [{ ...target, role: "api" }], policy: { windowMs: 1000, httpMinRequests: 1 } });
  let previous: MonitorState | null = null;
  for (let i = 0; i < 2; i++) {
    const time = at + i * 1000;
    previous = evaluateMonitor(c, previous, [{ targetId: target.id, reason: "ok", observedAt: time, snapshot: {
      instance: "f1a0b35c-307f-4fc7-81f2-5539ca56264b", ready: true, databaseAvailable: true,
      backlog: { pending: 0, oldestAgeSeconds: 0, deadLetters: 0 }, http: { requests: 10 + i * 10, errors: 0 }, mailFailures: 0,
    } }], time).state;
  }
  for (const [id, value] of [["http_5xx", 1], ["mail_delivery_failures", 1], ["notification_backlog", 120]] as const) {
    const corrupt = structuredClone(previous!);
    corrupt.targets[0].lastObservation!.rules.find(rule => rule.id === id)!.value = value;
    assert.throws(() => monitorStatus(c, corrupt, at + 1000), { code: "state_invalid" });
  }
});

test("a configuration transaction cannot retain a pre-change verdict even at an equal wall-clock timestamp", () => {
  const state = check(config, null, at);
  const next = parseMonitorConfig({ version: 1, targets: [target], policy: { pendingEvents: 2 } });
  const migrated = reconfigureMonitor(config, next, state, at).state;
  migrated.targets[0].lastObservation = structuredClone(state.targets[0].lastObservation);
  assert.throws(() => parseMonitorState(migrated, next), { code: "state_invalid" });
});
