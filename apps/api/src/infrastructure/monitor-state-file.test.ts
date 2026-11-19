import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { acknowledgeMonitorEvents, evaluateMonitor } from "../application/operational-alerts.ts";
import { parseMonitorConfig } from "./monitor-config.ts";
import { MONITOR_STATE_MAX_BYTES, openMonitorJournal, readMonitorJournal, readMonitorConfigFile } from "./monitor-state-file.ts";

const config = parseMonitorConfig({ version: 1, targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9100/metrics" }], rules: { target_unavailable: { forMs: 0 } } });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "no-wave-monitor-state-")); chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "alerts.json") };
}
function state(at = 1_800_000_000_000) {
  return evaluateMonitor(config, null, [{ targetId: "worker-one", observedAt: at, reason: "timeout", snapshot: null }], at).state;
}

test("the local journal is private, atomic, independently readable and exclusively locked", t => {
  const f = fixture(t);
  const journal = openMonitorJournal(f.path, config);
  assert.equal(journal.state, null);
  assert.throws(() => openMonitorJournal(f.path, config), { code: "state_locked" });
  const next = state(); journal.commit(next);
  assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(readMonitorJournal(f.path, config), next);
  journal.close(); journal.close();
  assert.equal(existsSync(f.path + ".lock"), false);
  const reopened = openMonitorJournal(f.path, config); assert.deepEqual(reopened.state, next); reopened.close();
});

test("a corrupt, overly large, unsafe-permission or foreign-config journal never gets replaced", t => {
  const f = fixture(t);
  for (const content of ['{"token":"must-not-surface"}', "{" , "x".repeat(MONITOR_STATE_MAX_BYTES + 1)]) {
    writeFileSync(f.path, content, { mode: 0o600 });
    assert.throws(() => openMonitorJournal(f.path, config), { code: "state_invalid" });
    assert.equal(readFileSync(f.path, "utf8"), content);
    assert.equal(existsSync(f.path + ".lock"), false);
  }
  writeFileSync(f.path, JSON.stringify(state()), { mode: 0o600 }); chmodSync(f.path, 0o644);
  assert.throws(() => openMonitorJournal(f.path, config), { code: "state_io" });
  chmodSync(f.path, 0o600);
  const other = parseMonitorConfig({ version: 1, targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: "http://127.0.0.1:9101/metrics" }] });
  assert.throws(() => openMonitorJournal(f.path, other), { code: "state_config_mismatch" });
});

test("state and lock symlinks, and public parent directories, fail closed", t => {
  const f = fixture(t), victim = join(f.directory, "victim");
  writeFileSync(victim, "private-local-canary", { mode: 0o600 }); symlinkSync(victim, f.path);
  assert.throws(() => openMonitorJournal(f.path, config), { code: "state_io" });
  assert.equal(readFileSync(victim, "utf8"), "private-local-canary"); rmSync(f.path);
  symlinkSync(victim, f.path + ".lock");
  assert.throws(() => openMonitorJournal(f.path, config), { code: "state_locked" }); rmSync(f.path + ".lock");
  chmodSync(f.directory, 0o755);
  assert.throws(() => openMonitorJournal(f.path, config), { code: "state_io" });
});

test("a writer that ignores the lock cannot be silently overwritten", t => {
  const f = fixture(t);
  const first = openMonitorJournal(f.path, config); first.commit(state()); first.close();
  const journal = openMonitorJournal(f.path, config);
  const foreign = readFileSync(f.path, "utf8") + "\n"; writeFileSync(f.path, foreign);
  const next = evaluateMonitor(config, journal.state, [{ targetId: "worker-one", reason: "timeout", snapshot: null, observedAt: 1_800_000_001_000 }], 1_800_000_001_000).state;
  assert.throws(() => journal.commit(next), { code: "state_io" }); journal.close();
  assert.equal(readFileSync(f.path, "utf8"), foreign);
});

test("a replaced lock is not owned by the old writer and must not be removed by cleanup", t => {
  const f = fixture(t), journal = openMonitorJournal(f.path, config);
  renameSync(f.path + ".lock", f.path + ".old-lock");
  writeFileSync(f.path + ".lock", "another-live-owner", { mode: 0o600 });
  assert.throws(() => journal.commit(state()), { code: "state_io" });
  assert.throws(() => journal.close(), { code: "state_io" });
  assert.equal(readFileSync(f.path + ".lock", "utf8"), "another-live-owner");
  assert.equal(existsSync(f.path), false);
});

test("a commit cannot move revision or observed time backwards", t => {
  const f = fixture(t), journal = openMonitorJournal(f.path, config), next = state();
  journal.commit(next);
  const previousText = readFileSync(f.path, "utf8");
  assert.throws(() => journal.commit({ ...next, revision: 0 }), { code: "state_invalid" });
  assert.throws(() => journal.commit({ ...next, revision: next.revision + 2 }), { code: "state_invalid" });
  journal.commit(next);
  assert.equal(readFileSync(f.path, "utf8"), previousText); journal.close();
});

test("an idempotent commit still detects an external file replacement", t => {
  const f = fixture(t), journal = openMonitorJournal(f.path, config), next = state();
  journal.commit(next);
  const foreign = readFileSync(f.path, "utf8") + "\n"; writeFileSync(f.path, foreign);
  assert.throws(() => journal.commit(next), { code: "state_io" }); journal.close();
  assert.equal(readFileSync(f.path, "utf8"), foreign);
});

test("a parent directory made public while scraping cannot receive a later state commit", t => {
  const f = fixture(t), journal = openMonitorJournal(f.path, config);
  chmodSync(f.directory, 0o755);
  assert.throws(() => journal.commit(state()), { code: "state_io" });
  chmodSync(f.directory, 0o700); journal.close(); assert.equal(existsSync(f.path), false);
});

test("config reads are bounded, strict UTF-8 JSON and never permit a writable or symlink source", t => {
  const f = fixture(t), path = join(f.directory, "config.json");
  writeFileSync(path, JSON.stringify({ version: 1, targets: [{ id: "api-one", role: "api", metricsUrl: "http://127.0.0.1:4000/metrics" }] }), { mode: 0o644 });
  assert.equal(readMonitorConfigFile(path).targets[0].id, "api-one");
  chmodSync(path, 0o666); assert.throws(() => readMonitorConfigFile(path), { code: "config_invalid" });
  chmodSync(path, 0o600); writeFileSync(path, Buffer.from([0xc3, 0x28]));
  assert.throws(() => readMonitorConfigFile(path), { code: "config_invalid" });
});

test("configuration changes use the same exclusive atomic journal transaction and preserve incident state", t => {
  const f = fixture(t), journal = openMonitorJournal(f.path, config), first = state();
  journal.commit(first);
  const acknowledged = acknowledgeMonitorEvents(config, first, first.events[0].id).state; journal.commit(acknowledged);
  const next = parseMonitorConfig({ version: 1, targets: config.targets, policy: { pendingEvents: 10 }, rules: { target_unavailable: { forMs: 0 } } });
  assert.throws(() => openMonitorJournal(f.path, next), { code: "state_locked" });
  const configuredAt = first.lastEvaluatedAt! + 5000;
  const migrated = journal.reconfigure(next, configuredAt);
  assert.equal(migrated.changed, true); assert.equal(migrated.state.revision, acknowledged.revision + 1);
  assert.equal(migrated.state.lastEvaluatedAt, first.lastEvaluatedAt);
  assert.deepEqual(journal.state, readMonitorJournal(f.path, next));
  assert.throws(() => readMonitorJournal(f.path, config), { code: "state_config_mismatch" });
  assert.throws(() => evaluateMonitor(next, journal.state, [], configuredAt - 1), { code: "clock_rollback" });
  const previousText = readFileSync(f.path, "utf8");
  assert.equal(journal.reconfigure(next, configuredAt).changed, false);
  assert.equal(readFileSync(f.path, "utf8"), previousText);
  journal.close(); assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
});

test("configuration changes cannot overwrite an independently replaced journal", t => {
  const f = fixture(t), journal = openMonitorJournal(f.path, config), first = state(); journal.commit(first);
  const cleared = acknowledgeMonitorEvents(config, first, first.events[0].id).state; journal.commit(cleared);
  const next = parseMonitorConfig({ version: 1, targets: config.targets, policy: { pendingEvents: 10 } });
  const foreign = readFileSync(f.path, "utf8") + "\n"; writeFileSync(f.path, foreign);
  assert.throws(() => journal.reconfigure(next, first.lastEvaluatedAt! + 1000), { code: "state_io" });
  assert.equal(readFileSync(f.path, "utf8"), foreign); journal.close();
  assert.equal(readMonitorJournal(f.path, config)?.fingerprint, config.fingerprint);
});
