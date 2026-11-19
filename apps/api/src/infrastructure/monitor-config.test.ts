import assert from "node:assert/strict";
import test from "node:test";
import { parseMonitorConfig } from "./monitor-config.ts";

const target = { id: "api-one", role: "api", metricsUrl: "http://127.0.0.1:4000/metrics" };
const config = (extra = {}) => ({ version: 1, targets: [target], ...extra });
const invalid = (value: unknown) => assert.throws(() => parseMonitorConfig(value), { code: "config_invalid" });

test("monitoring has no implicit endpoint or production enablement", () => {
  invalid({});
  invalid({ version: 1, targets: [] });
  const parsed = parseMonitorConfig(config());
  assert.equal(parsed.targets[0].metricsUrl, target.metricsUrl);
  assert.equal(parsed.scrapeTimeoutMs, 2000);
  assert.equal(parsed.policy.windowMs, 300_000);
  assert.equal(parsed.rules.notification_dead_letters.forMs, 0);
  assert.match(parsed.fingerprint, /^[a-f0-9]{64}$/);
});

test("untrusted URLs cannot smuggle credentials, paths, queries or a protocol change", () => {
  for (const metricsUrl of ["file:///metrics", "http://user:canary@localhost/metrics", "http://localhost/metrics?token=canary", "http://localhost/metrics#canary", "http://localhost/admin", "http:\\localhost\\metrics", " http://localhost/metrics", "http://10.1.2.3/metrics", "http://localhost:65536/metrics"]) {
    invalid(config({ targets: [{ ...target, metricsUrl }] }));
  }
  assert.equal(parseMonitorConfig(config({ allowInsecureHttp: true, targets: [{ ...target, metricsUrl: "http://10.1.2.3/metrics" }] })).allowInsecureHttp, true);
  assert.equal(parseMonitorConfig(config({ targets: [{ ...target, metricsUrl: "https://monitor.example/metrics" }] })).targets.length, 1);
});

test("target identity and canonical origins are unique, bounded, and strictly typed", () => {
  invalid(config({ targets: [target, target] }));
  invalid(config({ targets: [target, { ...target, id: "api-two" }] }));
  invalid(config({ targets: [{ ...target, id: "user@example.test" }] }));
  invalid(config({ targets: [{ ...target, role: "browser" }] }));
  invalid(config({ targets: [{ ...target, token: "not-allowed" }] }));
  invalid(config({ targets: Array.from({ length: 17 }, (_, i) => ({ ...target, id: `api-${i}`, metricsUrl: `http://127.0.0.1:${4000 + i}/metrics` })) }));
});

test("the fingerprint covers policy and destinations but not JSON key or target order", () => {
  const other = { id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" };
  const a = parseMonitorConfig(config({ targets: [target, other] }));
  const b = parseMonitorConfig({ targets: [other, { metricsUrl: target.metricsUrl, role: "api", id: target.id }], version: 1 });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, parseMonitorConfig(config()).fingerprint);
  assert.notEqual(a.fingerprint, parseMonitorConfig(config({ policy: { httpErrorRatio: 0.2 } })).fingerprint);
});

test("threshold and timing mistakes fail closed instead of silently turning off rules", () => {
  for (const extra of [{ policy: { windowMs: 0 } }, { policy: { httpErrorRatio: 0 } }, { policy: { httpErrorRatio: 1.1 } }, { policy: { maxGapMs: 999 } }, { policy: { minIntervalMs: 5000, maxGapMs: 2000 } }, { policy: { windowMs: 1000, minIntervalMs: 2000 } }, { policy: { mailFailures: "1" } }, { policy: null }, { rules: null }, { rules: { http_5xx: null } }, { policy: { unknown: 1 } }, { scrapeTimeoutMs: 60_001 }, { scrapeTimeoutMs: 2000, runTimeoutMs: 1000 }, { rules: { http_5xx: { forMs: -1 } } }, { rules: { made_up: {} } }, { rules: { target_unavailable: { repeatMs: 0 } } }, { allowInsecureHttp: "true" }, { token: "canary" }]) invalid(config(extra));
  const parsed = parseMonitorConfig(config({ rules: { http_5xx: { forMs: 0, resolveMs: 0 } } }));
  assert.equal(parsed.rules.http_5xx.forMs, 0);
  assert.equal(parsed.rules.http_5xx.resolveMs, 0);
});
