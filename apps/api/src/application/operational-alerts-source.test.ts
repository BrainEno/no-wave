import assert from "node:assert/strict";
import test from "node:test";
import { parseMonitorConfig } from "../infrastructure/monitor-config.ts";
import { evaluateMonitor } from "./operational-alerts.ts";

const start = 1_800_000_000_000;
const config = parseMonitorConfig({ version: 1, targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" }],
  policy: { minIntervalMs: 1000, maxGapMs: 5000 }, rules: { target_unavailable: { forMs: 2000, resolveMs: 1000 } } });
const failed = (at: number) => [{ targetId: "worker-one", observedAt: at, reason: "timeout" as const, snapshot: null }];

test("continuous failed scrapes can fire their own availability alert while domain signals remain unknown", () => {
  let result = evaluateMonitor(config, null, failed(start), start);
  result = evaluateMonitor(config, result.state, failed(start + 1000), start + 1000);
  result = evaluateMonitor(config, result.state, failed(start + 2000), start + 2000);
  const rules = result.report.targets[0].rules;
  assert.equal(rules.find(rule => rule.id === "target_unavailable")?.phase, "firing");
  assert.equal(rules.find(rule => rule.id === "notification_dead_letters")?.condition, "unknown");
  assert.equal(rules.some(rule => rule.id === "database_unavailable"), false, "a worker cannot claim database health from missing API-only metrics");
  assert.equal(result.state.events.length, 1);
});

test("a missed monitor interval does not count as two seconds of failed monitoring", () => {
  const first = evaluateMonitor(config, null, failed(start), start);
  const afterGap = evaluateMonitor(config, first.state, failed(start + 10_000), start + 10_000);
  assert.equal(afterGap.report.targets[0].rules.find(rule => rule.id === "target_unavailable")?.phase, "pending");
  assert.equal(afterGap.state.events.length, 0);
});

test("replayed or out-of-order failed observations cannot manufacture continuous outage evidence", () => {
  const first = evaluateMonitor(config, null, failed(start), start);
  const previous = JSON.stringify(first.state);
  for (const at of [start, start - 1]) {
    assert.throws(() => evaluateMonitor(config, first.state, failed(at), start + 2000), { code: "invalid_metrics" });
  }
  assert.equal(JSON.stringify(first.state), previous);
});
