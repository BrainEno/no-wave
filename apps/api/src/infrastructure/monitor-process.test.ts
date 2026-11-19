import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { closeSync, constants, existsSync, openSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evaluateMonitor } from "../application/operational-alerts.ts";
import type { MonitorState } from "../application/operational-monitor.ts";
import { parseMonitorConfig } from "./monitor-config.ts";

const entry = fileURLToPath(new URL("./monitor-command.ts", import.meta.url));
function child(args: string[]) {
  const process = spawn(globalThis.process.execPath, [entry, ...args], { env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, NODE_NO_WARNINGS: "1",
    DATABASE_PROVIDER: "must-not-open", DATABASE_URL: "private-process-dsn-canary", AUTH_JWT_SECRET: "private-process-auth-canary" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", data => { stdout += String(data); }); process.stderr.on("data", data => { stderr += String(data); });
  const exited = once(process, "close");
  const timeout = setTimeout(() => process.kill("SIGKILL"), 8000);
  const done = exited.finally(() => clearTimeout(timeout));
  return { process, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test("two actual monitor processes serialize the whole scrape and SIGTERM cancels sockets before releasing the journal", { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nw-monitor-process-")); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let hits = 0, active = 0, stalled = true;
  const server = createServer((_request, response) => {
    hits++; active++; response.once("close", () => { active--; });
    if (stalled) { response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }); response.write("# hanging-owned-response\n"); }
    else { response.writeHead(503); response.end("private-source-body-canary"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const config = join(directory, "monitor.json"), state = join(directory, "alerts.json");
  await writeFile(config, JSON.stringify({ version: 1, targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: `http://127.0.0.1:${address.port}/metrics` }],
    scrapeTimeoutMs: 5000, runTimeoutMs: 5000, rules: { target_unavailable: { forMs: 0 } } }), { mode: 0o600 });
  const options = ["--config", config, "--state", state];
  const arrived = once(server, "request");
  const first = child(["check", ...options]);
  t.after(async () => { if (first.process.exitCode === null && first.process.signalCode === null) first.process.kill("SIGKILL"); await first.done; });
  await arrived; assert.equal(existsSync(state + ".lock"), true);
  const blocked = child(["check", ...options]); assert.deepEqual(await blocked.done, [3, null]);
  assert.equal(JSON.parse(blocked.stderr).code, "state_locked"); assert.equal(hits, 1);
  const at = performance.now(); first.process.kill("SIGTERM");
  assert.deepEqual(await first.done, [3, null]); assert.ok(performance.now() - at < 2000);
  assert.equal(JSON.parse(first.stderr).code, "cancelled"); assert.equal(active, 0);
  assert.equal(existsSync(state), false); assert.equal(existsSync(state + ".lock"), false);
  stalled = false;
  const resumed = child(["check", ...options]); assert.deepEqual(await resumed.done, [1, null]);
  const report = JSON.parse(resumed.stdout); assert.equal(report.events.length, 1); assert.equal(report.targets[0].source, "http_status");
  assert.equal(hits, 2); assert.equal(JSON.parse(await readFile(state, "utf8")).events[0].id, report.events[0].id);
  assert.doesNotMatch(first.stderr + blocked.stderr + resumed.stdout + resumed.stderr, /private-|127\.0\.0\.1|metricsUrl|monitor\.json|alerts\.json/);
});

test("a real blocked stdout times out after committing and never acknowledges its durable event queue", { timeout: 12_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nw-monitor-output-")); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((_request, response) => { response.writeHead(503); response.end("private-output-source-canary"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const document = { version: 1, targets: [{ id: "worker-one", role: "notification-worker", metricsUrl: `http://127.0.0.1:${address.port}/metrics` }],
    rules: { target_unavailable: { forMs: 0, repeatMs: 30_000 } } };
  const config = parseMonitorConfig(document), statePath = join(directory, "alerts.json"), configPath = join(directory, "monitor.json");
  let state: MonitorState | null = null;
  const start = Date.now() - 200 * 30_000 - 5000;
  for (let i = 0; i < 200; i++) {
    const at = start + i * 30_000;
    state = evaluateMonitor(config, state, [{ targetId: "worker-one", observedAt: at, reason: "timeout", snapshot: null }], at).state;
  }
  assert.equal(state!.events.length, 200);
  await writeFile(configPath, JSON.stringify(document), { mode: 0o600 }); await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  const fifo = join(directory, "unread-stdout");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  t.after(() => closeSync(reader));
  let filled = false;
  for (let i = 0; i < 1024; i++) {
    try { writeSync(writer, Buffer.alloc(4096, 32)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; filled = true; break; }
  }
  assert.equal(filled, true, "the OS pipe must really be full before the child attempts output");
  const before = performance.now();
  const process = spawn(globalThis.process.execPath, [entry, "check", "--config", configPath, "--state", statePath], {
    env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", writer, "pipe"],
  });
  closeSync(writer);
  let stderr = ""; process.stderr!.on("data", data => { stderr += String(data); });
  const done = once(process, "close");
  const timeout = setTimeout(() => process.kill("SIGKILL"), 8000);
  t.after(async () => { clearTimeout(timeout); if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); await done; });
  assert.deepEqual(await done, [3, null], stderr); clearTimeout(timeout);
  assert.ok(performance.now() - before < 6000);
  assert.equal(JSON.parse(stderr).code, "output_failed");
  const committed = JSON.parse(await readFile(statePath, "utf8")) as MonitorState;
  assert.equal(committed.revision, state!.revision + 1);
  assert.equal(committed.events.length, 201);
  assert.equal(committed.events[0].id, state!.events[0].id);
  assert.equal(committed.acknowledgedThrough, null); assert.equal(existsSync(statePath + ".lock"), false);
  const inspected = child(["inspect", "--config", configPath, "--state", statePath]); assert.deepEqual(await inspected.done, [0, null]);
  assert.equal(JSON.parse(inspected.stdout).unacknowledged, 201);
  assert.doesNotMatch(stderr + inspected.stdout, /private-|127\.0\.0\.1|metricsUrl|monitor\.json|alerts\.json/);
});

test("named pipes masquerading as local config or state cannot block the finite command before validation", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nw-monitor-fifo-")); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fifo = join(directory, "not-a-regular-file"), config = join(directory, "monitor.json"), state = join(directory, "alerts.json");
  execFileSync("mkfifo", ["-m", "600", fifo]);
  await writeFile(config, JSON.stringify({ version: 1, targets: [{ id: "api-one", role: "api", metricsUrl: "http://127.0.0.1:4000/metrics" }] }), { mode: 0o600 });
  for (const [configPath, statePath, expected, code] of [[fifo, state, 2, "config_invalid"], [config, fifo, 3, "state_io"]] as const) {
    const process = child(["check", "--config", configPath, "--state", statePath]);
    assert.deepEqual(await process.done, [expected, null]); assert.equal(JSON.parse(process.stderr).code, code);
    assert.equal(existsSync(statePath + ".lock"), false); assert.equal(existsSync(state), false);
  }
});
