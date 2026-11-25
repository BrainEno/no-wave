import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integrityOptions, notificationIntegrityFixture } from "../persistence/test-support/notification-integrity-fixture.ts";

for (const role of ["api", "notification-worker"] as const) for (const releases of [true, false]) {
  test(`postgres: SIGTERM during ${role} persistence acquisition ${releases ? "closes the subsequently acquired pool exactly once without starting work" : "fails honestly inside the deadline when schema acquisition stays blocked"}`, { ...integrityOptions("postgres"), timeout: 20_000 }, async t => {
    const f = await notificationIntegrityFixture(t, "postgres");
    const [schema] = await f.query("SELECT current_schema() AS name");
    const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set("search_path", `${String(schema.name)},public`);
    let unlock!: () => void, acquired!: () => void;
    const hold = new Promise<void>(resolve => { unlock = resolve; });
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const transaction = f.sql!.begin(async tx => { await tx.unsafe("LOCK TABLE api_schema_migrations IN ACCESS EXCLUSIVE MODE"); acquired(); await hold; });
    await locked;
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1", SERVICE_ROLE: role, OUTBOX_HEALTH_PORT: String(address.port), DATABASE_PROVIDER: "postgres", DATABASE_URL: url.toString(),
        PORT: "0", HOST: "0.0.0.0", SHUTDOWN_GRACE_MS: "600", SHUTDOWN_CLEANUP_MS: "150",
        AUTH_JWT_SECRET: "private-startup-secret-canary-with-at-least-32-bytes", AUTH_JWT_ISSUER: "http://localhost", AUTH_JWT_AUDIENCE: "startup" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "close");
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    try {
      const deadline = performance.now() + 5000;
      let blocked = false;
      while (!blocked && performance.now() < deadline) {
        const [row] = await f.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'no-wave-api' AND wait_event_type = 'Lock' AND query = 'SELECT version FROM api_schema_migrations'");
        blocked = Number(row.count) === 1;
        if (!blocked) await delay(20);
      }
      assert.equal(blocked, true, "a real provider query must be blocked before signalling the process");
      if (role === "notification-worker") {
        const origin = `http://127.0.0.1:${address.port}`;
        const health = await fetch(origin + "/health?private-startup-probe-canary", { signal: AbortSignal.timeout(1000) });
        assert.equal(health.status, 200, "liveness must not wait for a blocked provider acquisition");
        const starting = await fetch(origin + "/ready", { signal: AbortSignal.timeout(1000) });
        assert.equal(starting.status, 503);
        const state = await starting.json();
        assert.equal(state.phase, "starting"); assert.equal(state.reason, "starting");
        assert.equal(state.lastSuccessAt, null); assert.equal(state.completedBatches, 0);
      }
      const started = performance.now();
      child.kill("SIGTERM");
      if (releases) { await delay(60); unlock(); await transaction; }
      const result = await Promise.race([exited, delay(1600, undefined, { ref: false }).then(() => { throw new Error("API startup shutdown exceeded its deadline."); })]);
      assert.deepEqual(result, [releases ? 0 : 1, null]);
      assert.ok(performance.now() - started < 1400);
      const records = output.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
      const prefix = role === "api" ? "api" : "notification_worker";
      assert.equal(records.filter(row => row.event === `${prefix}_persistence_closed`).length, releases ? 1 : 0);
      const report = records.find(row => row.event === `${prefix}_shutdown_complete`);
      assert.equal(report?.forced, !releases);
      assert.equal(report?.cleanupSucceeded, releases);
      assert.equal(report?.exitCode, releases ? 0 : 1);
      assert.ok(!records.some(row => row.event === "api.runtime_compatibility" || row.event === "worker_started"), "shutdown during startup must not resurrect a listener");
      assert.doesNotMatch(output, /private-startup-secret-canary|private-startup-probe-canary|postgres:\/\//);
    } finally {
      unlock(); await transaction;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}

for (const role of ["api", "notification-worker"] as const) for (const releases of [true, false]) {
  test(`postgres: ${role} startup deadline fails closed without a signal when acquisition ${releases ? "recovers during cleanup" : "remains blocked"}`, { ...integrityOptions("postgres"), timeout: 20_000 }, async t => {
    const f = await notificationIntegrityFixture(t, "postgres");
    const [schema] = await f.query("SELECT current_schema() AS name");
    const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set("search_path", `${String(schema.name)},public`);
    let unlock!: () => void, locked!: () => void;
    const held = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const transaction = f.sql!.begin(async tx => { await tx.unsafe("LOCK TABLE api_schema_migrations IN ACCESS EXCLUSIVE MODE"); locked(); await held; });
    await acquired;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1", SERVICE_ROLE: role,
        DATABASE_PROVIDER: "postgres", DATABASE_URL: url.toString(), OUTBOX_HEALTH_PORT: "0", PORT: "0", HOST: "127.0.0.1",
        SERVICE_STARTUP_TIMEOUT_MS: "1500", SHUTDOWN_GRACE_MS: "600", SHUTDOWN_CLEANUP_MS: "150",
        AUTH_JWT_SECRET: "private-startup-deadline-canary-at-least-thirty-two-bytes", AUTH_JWT_ISSUER: "http://localhost", AUTH_JWT_AUDIENCE: "startup" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = once(child, "close");
    const prefix = role === "api" ? "api" : "notification_worker";
    try {
      const started = performance.now();
      const deadline = started + 4500;
      while (!output.includes(`${prefix}_startup_deadline_reached`) && performance.now() < deadline && child.exitCode === null) await delay(20);
      assert.match(output, new RegExp(`${prefix}_startup_deadline_reached`), "the application must end a wedged bootstrap without relying on SIGTERM or an external supervisor");
      if (releases) { unlock(); await transaction; }
      const result = await Promise.race([exited, delay(1500, undefined, { ref: false }).then(() => { throw new Error("Startup timeout did not trigger bounded teardown."); })]);
      assert.deepEqual(result, [1, null], "recovering a pool cannot turn an expired startup into success");
      assert.ok(performance.now() - started < 5500);
      const records = output.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
      const timeouts = records.filter(row => row.event === `${prefix}_startup_deadline_reached`);
      assert.equal(timeouts.length, 1); assert.equal(timeouts[0]!.timeoutMs, 1500);
      assert.equal(records.filter(row => row.event === `${prefix}_persistence_closed`).length, releases ? 1 : 0);
      assert.equal(records.filter(row => row.event === `${prefix}_shutdown_complete`).length, 1);
      assert.ok(!records.some(row => row.event === "api.runtime_compatibility" || row.event === "worker_started"), "late startup must not resurrect a stopped role");
      assert.doesNotMatch(output, /private-startup-deadline-canary|postgres:\/\//);
    } finally {
      unlock(); await transaction;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}
