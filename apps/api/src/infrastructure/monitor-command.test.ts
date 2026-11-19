import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { runMonitorCommand } from "./monitor-command.ts";
import { readMonitorJournal, readMonitorConfigFile } from "./monitor-state-file.ts";
import type { MonitorObservation } from "../application/operational-monitor.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "no-wave-monitor-cli-")); chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json"), state = join(directory, "alerts.json");
  writeFileSync(config, JSON.stringify({ version: 1, targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" }], rules: { target_unavailable: { forMs: 0, resolveMs: 0 } } }), { mode: 0o600 });
  let clock = 1_800_000_000_000, requests = 0;
  const stdout: string[] = [], stderr: string[] = [];
  const collect = async (): Promise<MonitorObservation[]> => { requests++; return [{ targetId: "worker-one", observedAt: clock, reason: "timeout", snapshot: null }]; };
  const dependencies = { stdout: (value: string) => { stdout.push(value); }, stderr: (value: string) => { stderr.push(value); }, now: () => clock, collect };
  return { directory, config, state, dependencies, stdout, stderr, requests: () => requests, advance: (ms = 1000) => { clock += ms; }, options: ["--config", config, "--state", state] };
}

test("help and invalid arguments never load a database, acquire a journal or make a request", async t => {
  const f = fixture(t);
  assert.equal(await runMonitorCommand(["--help"], f.dependencies), 0);
  assert.match(f.stdout[0], /check.*inspect.*ack/s);
  for (const args of [[], ["watch"], ["check", ...f.options, "--token", "private-cli-canary"], ["check", ...f.options, "--config", f.config], ["ack", ...f.options], ["check", ...f.options, "--through", "a".repeat(64)]]) {
    assert.equal(await runMonitorCommand(args, f.dependencies), 2);
  }
  assert.equal(f.requests(), 0); assert.equal(existsSync(f.state), false);
  assert.doesNotMatch(f.stderr.join(""), /private-cli-canary|127\.0\.0\.1|config\.json|DATABASE_URL/);
});

test("check persists before output, inspect performs no scrape, and ack is exact and retryable", async t => {
  const f = fixture(t);
  assert.equal(await runMonitorCommand(["check", ...f.options], f.dependencies), 1);
  const report = JSON.parse(f.stdout.at(-1)!);
  assert.equal(report.event, "monitor_check"); assert.equal(report.events.length, 1);
  const initial = readFileSync(f.state, "utf8");
  assert.equal(await runMonitorCommand(["inspect", ...f.options], f.dependencies), 0);
  assert.equal(f.requests(), 1); assert.equal(readFileSync(f.state, "utf8"), initial);
  const inspected = JSON.parse(f.stdout.at(-1)!); assert.equal(inspected.events[0].id, report.events[0].id);
  assert.doesNotMatch(f.stdout.join(""), /metricsUrl|127\.0\.0\.1|\/metrics/);
  const receipt = report.events[0].id;
  assert.equal(await runMonitorCommand(["ack", ...f.options, "--through", receipt], f.dependencies), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)!).acknowledged, 1);
  assert.equal(await runMonitorCommand(["ack", ...f.options, "--through", receipt], f.dependencies), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)!).acknowledged, 0);
  assert.equal(f.requests(), 1);
  const acknowledged = readFileSync(f.state, "utf8");
  assert.equal(await runMonitorCommand(["ack", ...f.options, "--through", "a".repeat(64)], f.dependencies), 3);
  assert.equal(readFileSync(f.state, "utf8"), acknowledged);
});

test("clock and minimum-interval failures happen before any new outbound request", async t => {
  const f = fixture(t);
  await runMonitorCommand(["check", ...f.options], f.dependencies);
  const previous = readFileSync(f.state, "utf8");
  assert.equal(await runMonitorCommand(["check", ...f.options], f.dependencies), 3);
  assert.equal(f.requests(), 1); assert.equal(readFileSync(f.state, "utf8"), previous);
  assert.match(f.stderr.at(-1)!, /sample_too_soon/);
  f.advance(); assert.equal(await runMonitorCommand(["check", ...f.options], f.dependencies), 1);
  assert.equal(f.requests(), 2);
});

test("a failed stdout delivery leaves a durable, unacknowledged event and only a closed error code", async t => {
  const f = fixture(t);
  const code = await runMonitorCommand(["check", ...f.options], { ...f.dependencies, stdout() { throw new Error("private-output-canary postgres://user:credential@private/db"); } });
  assert.equal(code, 3); assert.match(f.stderr.at(-1)!, /output_failed/);
  assert.doesNotMatch(f.stderr.join(""), /private-output-canary|postgres|credential|Error:|stack/);
  const state = readMonitorJournal(f.state, readMonitorConfigFile(f.config));
  assert.equal(state?.events.length, 1);
  assert.equal(state?.events[0].transition, "firing");
  assert.equal(existsSync(f.state + ".lock"), false);
});

test("cancellation before or during collection never writes state or leaves an owned lock", async t => {
  const f = fixture(t), controller = new AbortController();
  assert.equal(await runMonitorCommand(["check", ...f.options], { ...f.dependencies, signal: AbortSignal.abort() }), 3);
  assert.equal(f.requests(), 0); assert.equal(existsSync(f.state), false);
  const code = await runMonitorCommand(["check", ...f.options], { ...f.dependencies, signal: controller.signal, collect: async () => { controller.abort(); return f.dependencies.collect(); } });
  assert.equal(code, 3); assert.equal(existsSync(f.state), false); assert.equal(existsSync(f.state + ".lock"), false);
});

test("explicit reconfiguration is offline, atomic and cannot erase undelivered or active incidents", async t => {
  const f = fixture(t), nextConfig = join(f.directory, "next.json");
  const document = JSON.parse(readFileSync(f.config, "utf8"));
  writeFileSync(nextConfig, JSON.stringify({ ...document, policy: { pendingEvents: 50 } }), { mode: 0o600 });
  const args = ["reconfigure", ...f.options, "--next-config", nextConfig];
  assert.equal(await runMonitorCommand(["check", ...f.options], f.dependencies), 1);
  const previous = readFileSync(f.state, "utf8"), event = JSON.parse(f.stdout.at(-1)!).events[0];
  assert.equal(await runMonitorCommand(args, f.dependencies), 3);
  assert.match(f.stderr.at(-1)!, /config_pending_events/); assert.equal(readFileSync(f.state, "utf8"), previous);
  await runMonitorCommand(["ack", ...f.options, "--through", event.id], f.dependencies);
  f.advance();
  assert.equal(await runMonitorCommand(args, f.dependencies), 0);
  const result = JSON.parse(f.stdout.at(-1)!);
  assert.equal(result.event, "monitor_reconfigure"); assert.equal(result.changed, true);
  assert.equal(result.previousFingerprint, readMonitorConfigFile(f.config).fingerprint);
  assert.equal(result.fingerprint, readMonitorConfigFile(nextConfig).fingerprint);
  const changed = readMonitorJournal(f.state, readMonitorConfigFile(nextConfig))!;
  assert.equal(changed.targets[0].rules[0].phase, "firing");
  assert.equal(changed.lastEvaluatedAt, JSON.parse(previous).lastEvaluatedAt);
  assert.equal(f.requests(), 1); assert.equal(existsSync(f.state + ".lock"), false);
  assert.equal(await runMonitorCommand(["inspect", "--config", nextConfig, "--state", f.state], f.dependencies), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)!).lastConfigurationChange.at, changed.lastConfigurationChange!.at);
  const rebound = join(f.directory, "rebound.json");
  writeFileSync(rebound, JSON.stringify({ ...document, targets: [{ ...document.targets[0], metricsUrl: "http://127.0.0.1:9101/metrics" }] }), { mode: 0o600 });
  const beforeRebind = readFileSync(f.state, "utf8");
  assert.equal(await runMonitorCommand(["reconfigure", "--config", nextConfig, "--state", f.state, "--next-config", rebound], f.dependencies), 3);
  assert.match(f.stderr.at(-1)!, /config_active_targets/); assert.equal(readFileSync(f.state, "utf8"), beforeRebind);
  assert.equal(f.requests(), 1); assert.doesNotMatch(f.stdout.join(""), /127\.0\.0\.1|metricsUrl/);
});

test("reconfigure requires both explicit configs and validates their state/lock collisions without requests", async t => {
  const f = fixture(t), original = readFileSync(f.config, "utf8");
  for (const args of [["reconfigure", ...f.options], ["check", ...f.options, "--next-config", f.config], ["reconfigure", ...f.options, "--next-config", f.state], ["reconfigure", ...f.options, "--next-config", f.state + ".lock"]]) {
    assert.equal(await runMonitorCommand(args, f.dependencies), 2);
  }
  assert.equal(f.requests(), 0); assert.equal(readFileSync(f.config, "utf8"), original); assert.equal(existsSync(f.state), false);
});

test("a config/state collision cannot replace an operator's config or its lock", async t => {
  const f = fixture(t), original = readFileSync(f.config, "utf8");
  for (const state of [f.config, f.config + ".lock"]) {
    assert.equal(await runMonitorCommand(["check", "--config", f.config, "--state", state], f.dependencies), 2);
  }
  assert.equal(readFileSync(f.config, "utf8"), original); assert.equal(f.requests(), 0);
});

test("offline status is repeatable without scraping or locking and expires a previously observed healthy verdict", async t => {
  const f = fixture(t);
  assert.equal(await runMonitorCommand(["status", ...f.options], f.dependencies), 3);
  assert.equal(f.requests(), 0); assert.equal(existsSync(f.state + ".lock"), false);
  await runMonitorCommand(["check", ...f.options], f.dependencies);
  const current = readMonitorJournal(f.state, readMonitorConfigFile(f.config))!;
  const receipt = current.events[0].id;
  await runMonitorCommand(["ack", ...f.options, "--through", receipt], f.dependencies);
  const before = readFileSync(f.state, "utf8");
  assert.equal(await runMonitorCommand(["status", ...f.options], f.dependencies), 1);
  assert.equal(JSON.parse(f.stdout.at(-1)!).event, "monitor_status");
  assert.equal(readFileSync(f.state, "utf8"), before); assert.equal(f.requests(), 1);
  f.advance();
  const at = f.dependencies.now();
  assert.equal(await runMonitorCommand(["check", ...f.options], { ...f.dependencies, collect: async () => [{ targetId: "worker-one", observedAt: at, reason: "ok", snapshot: {
    instance: "6fe43461-1b4b-43f8-926c-49f18f8f3607", ready: true, databaseAvailable: null,
    backlog: { pending: 0, deadLetters: 0, oldestAgeSeconds: 0 }, http: null, mailFailures: null,
  } }] }), 1);
  const resolved = JSON.parse(f.stdout.at(-1)!).events[0].id;
  await runMonitorCommand(["ack", ...f.options, "--through", resolved], f.dependencies);
  const healthy = readFileSync(f.state, "utf8");
  for (let i = 0; i < 2; i++) assert.equal(await runMonitorCommand(["status", ...f.options], f.dependencies), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)!).health, "observed_healthy");
  f.advance(90_001);
  assert.equal(await runMonitorCommand(["status", ...f.options], f.dependencies), 3);
  assert.equal(JSON.parse(f.stdout.at(-1)!).targets[0].freshness, "stale");
  assert.equal(readFileSync(f.state, "utf8"), healthy); assert.equal(f.requests(), 1);
  assert.equal(existsSync(f.state + ".lock"), false);
});
