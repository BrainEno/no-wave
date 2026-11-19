import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApiServer } from "../server.ts";
import { createHttpObservability } from "./http-observability.ts";
import { MONITOR_RULES } from "../application/operational-monitor.ts";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "../persistence/test-support/notification-integrity-fixture.ts";

const entry = fileURLToPath(new URL("./monitor-command.ts", import.meta.url));
async function freePort() {
  const server = createPortReservation(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function command(args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1",
    DATABASE_PROVIDER: "must-not-be-opened", DATABASE_URL: "private-monitor-database-canary", AUTH_JWT_SECRET: "short-monitor-canary" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { const [code, signal] = await once(child, "close"); assert.equal(signal, null); return { code, stdout, stderr, body: stdout.trim() ? JSON.parse(stdout) : null }; }
  finally { clearTimeout(timer); }
}
async function waitFor(read: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) { if (read()) return; await delay(20); }
  throw new Error("The isolated worker did not become ready.");
}

for (const provider of integrityProviders) {
  test(`${provider}: real API, independent notification worker and monitor processes fire, retain, acknowledge and recover actual exported signals without changing domain rows`, { ...integrityOptions(provider), timeout: 35_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "nw-monitor-drill-")); await chmod(directory, 0o700);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "database.sqlite");
    const f = await notificationIntegrityFixture(t, provider, { sqliteFile: filename });
    const old = new Date(Date.now() - 600_000).toISOString();
    const dead = await f.enqueue("private-monitor-dead-letter-canary"), pending = await f.enqueue("private-monitor-delayed-message-canary");
    await f.query("UPDATE outbox_events SET dead_lettered_at = ? WHERE id = ?", [new Date().toISOString(), dead.eventId]);
    await f.query("UPDATE outbox_events SET created_at = ?, available_at = ? WHERE id = ?", [old, "2999-01-01T00:00:00.000Z", pending.eventId]);
    const metricsPort = await freePort(), closedSmtpPort = await freePort();
    let databaseUnavailable = false, productFailure = false;
    const observability = createHttpObservability({ logger() {} });
    const store = { ...f.store, health: () => databaseUnavailable ? false : f.store.health(),
      listPublishedArticles: (input: Parameters<typeof f.store.listPublishedArticles>[0]) => { if (productFailure) throw new Error("private-monitor-database-detail-canary"); return f.store.listPublishedArticles(input); } };
    const env = { AUTH_JWT_SECRET: "isolated-monitor-drill-issuer-not-production-material", AUTH_JWT_ISSUER: "monitor-drill", AUTH_JWT_AUDIENCE: "monitor-drill",
      API_METRICS_ENABLED: "true", API_READINESS_CACHE_MS: "0", API_READINESS_TIMEOUT_MS: "500", API_OUTBOX_MAX_PENDING_AGE_MS: "1000",
      MAIL_ENABLED: "true", MAIL_SMTP_HOST: "127.0.0.1", MAIL_SMTP_PORT: String(closedSmtpPort), MAIL_SMTP_SECURITY: "none", MAIL_FROM: "monitor@example.test", MAIL_SMTP_DELIVERY_DEADLINE_MS: "500" };
    const api = createApiServer({ env, store, observability, logger() {} }); api.listen(0, "0.0.0.0"); await once(api, "listening");
    t.after(async () => { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); });
    const address = api.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
    let databaseEnvironment: NodeJS.ProcessEnv = { DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename };
    if (provider === "postgres") {
      const [row] = await f.query("SELECT current_schema() AS name"); const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set("search_path", `${row.name},public`);
      databaseEnvironment = { DATABASE_PROVIDER: "postgres", DATABASE_URL: url.href };
    }
    const worker = spawn(process.execPath, [fileURLToPath(new URL("../service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", ...databaseEnvironment, SERVICE_ROLE: "notification-worker", OUTBOX_HEALTH_PORT: "0",
        OUTBOX_METRICS_PORT: String(metricsPort), OUTBOX_METRICS_REFRESH_INTERVAL_MS: "1000", OUTBOX_POLL_INTERVAL_MS: "100", SHUTDOWN_GRACE_MS: "1000", SHUTDOWN_CLEANUP_MS: "300" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let workerOutput = ""; worker.stdout.on("data", data => { workerOutput += String(data); }); worker.stderr.on("data", data => { workerOutput += String(data); });
    const workerExited = once(worker, "close");
    t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await workerExited; });
    await waitFor(() => workerOutput.includes('"event":"worker_ready"'));
    await delay(50);
    const config = join(directory, "monitor.json"), state = join(directory, "alerts.json");
    await writeFile(config, JSON.stringify({ version: 1, targets: [
      { id: "api-one", role: "api", metricsUrl: origin + "/metrics" },
      { id: "worker-one", role: "notification-worker", metricsUrl: `http://127.0.0.1:${metricsPort}/metrics` },
    ], policy: { windowMs: 1000, minIntervalMs: 1000, maxGapMs: 10_000, httpMinRequests: 1, pendingAgeSeconds: 1 },
    rules: Object.fromEntries(MONITOR_RULES.map(id => [id, { forMs: 0, resolveMs: 0 }])) }), { mode: 0o600 });
    const options = ["--config", config, "--state", state];
    const rows = () => f.query("SELECT id, payload, available_at, created_at, delivered_at, dead_lettered_at, lease_token FROM outbox_events ORDER BY id");
    const tick = async () => {
      const before = await rows(); const result = await command(["check", ...options]);
      assert.equal(result.stderr, ""); assert.equal(result.code, 1); assert.deepEqual(await rows(), before, "monitoring must not claim, replay, acknowledge or purge a domain outbox event");
      assert.doesNotMatch(result.stdout, /private-monitor-|short-monitor-canary|isolated-monitor-drill|postgres:|metricsUrl|127\.0\.0\.1/);
      return result.body;
    };
    const first = await tick();
    for (const target of first.targets) {
      assert.equal(target.source, "ok");
      assert.equal(target.rules.find(rule => rule.id === "notification_backlog").phase, "firing");
      assert.equal(target.rules.find(rule => rule.id === "notification_dead_letters").phase, "firing");
    }
    const registration = await fetch(origin + "/api/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "monitor-mailbox@example.test", password: "isolated-monitor-password-2026" }) });
    assert.equal(registration.status, 201); await registration.body?.cancel();
    const reset = await fetch(origin + "/api/v1/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "monitor-mailbox@example.test" }) });
    assert.equal(reset.status, 202); assert.deepEqual(await reset.json(), { data: { ok: true } }, "SMTP failure remains hidden from an enumerating caller, not from the monitor");
    productFailure = true; assert.equal((await fetch(origin + "/api/v1/articles?locale=en")).status, 500); productFailure = false;
    await delay(1100);
    const second = await tick(); const apiRules = second.targets.find(target => target.id === "api-one").rules;
    assert.equal(apiRules.find(rule => rule.id === "http_5xx").phase, "firing");
    assert.equal(apiRules.find(rule => rule.id === "mail_delivery_failures").phase, "firing");
    assert.equal(second.events[0].id, first.events[0].id, "a later check must redeliver the same unacknowledged receipt");
    assert.equal((await command(["ack", ...options, "--through", second.events.at(-1).id])).code, 0);
    await f.query("UPDATE outbox_events SET dead_lettered_at = NULL, delivered_at = ?", [new Date().toISOString()]);
    assert.equal((await fetch(origin + "/api/v1/articles?locale=en")).status, 200);
    await delay(1100);
    const recovered = await tick();
    assert.ok(recovered.targets.every(target => target.rules.every(rule => rule.phase === "inactive")));
    assert.ok(recovered.events.length >= 6); assert.ok(recovered.events.every(event => event.transition === "resolved"));
    assert.equal((await command(["ack", ...options, "--through", recovered.events.at(-1).id])).code, 0);
    const healthyStatus = await command(["status", ...options]);
    assert.equal(healthyStatus.code, 0); assert.equal(healthyStatus.body.health, "observed_healthy");
    worker.kill("SIGTERM"); assert.deepEqual(await workerExited, [0, null]); databaseUnavailable = true;
    await delay(1100);
    const unavailable = await tick(); const downApi = unavailable.targets.find(target => target.id === "api-one"), downWorker = unavailable.targets.find(target => target.id === "worker-one");
    assert.equal(downApi.rules.find(rule => rule.id === "database_unavailable").phase, "firing");
    assert.equal(downWorker.rules.find(rule => rule.id === "target_unavailable").phase, "firing");
    assert.equal(downWorker.rules.find(rule => rule.id === "notification_dead_letters").condition, "unknown");
    const inspection = await command(["inspect", ...options]); assert.equal(inspection.code, 0); assert.equal(inspection.body.unacknowledged, unavailable.events.length);
    const offline = await command(["status", ...options]); assert.equal(offline.code, 1); assert.equal(offline.body.health, "attention");
    assert.equal(offline.body.targets.find(target => target.id === "worker-one").rules.find(rule => rule.id === "notification_dead_letters").condition, "unknown");
  });
}
