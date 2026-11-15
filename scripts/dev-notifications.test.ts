import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "../apps/api/src/persistence/sqlite.ts";
import { createIsolatedPostgresTestSchema } from "../apps/api/src/persistence/test-support/isolated-postgres-schema.ts";
import { runNotificationDeliverySmoke } from "./notification-delivery-smoke.ts";

// Hold the whole tuple so the kernel cannot reissue one role's port to another.
// The later handoff to the real processes can still race an unrelated listener.
async function freeServicePorts(createReservation: () => Server = createServer): Promise<[number, number, number]> {
  const reservations: Server[] = [];
  const ports: number[] = [];
  try {
    for (let role = 0; role < 3; role += 1) {
      const server = createReservation(); reservations.push(server);
      server.listen(0, "0.0.0.0"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      ports.push(address.port);
    }
    return [ports[0]!, ports[1]!, ports[2]!];
  } finally {
    await Promise.all(reservations.filter(server => server.listening).map(server =>
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}

test("the dev fixture holds all three service ports until allocation is complete", async () => {
  const reservations: Server[] = [];
  const heldBeforeAllocation: number[] = [];
  const ports = await freeServicePorts(() => {
    heldBeforeAllocation.push(reservations.filter(server => server.listening).length);
    const server = createServer(); reservations.push(server); return server;
  });
  assert.deepEqual(heldBeforeAllocation, [0, 1, 2], "a released ephemeral port may be reassigned to another role");
  assert.equal(new Set(ports).size, 3);
  assert.ok(reservations.every(server => !server.listening), "all fixture reservations must be released before startup");
});

test("a failed dev fixture allocation releases every earlier reservation", async () => {
  const reservations: Server[] = [];
  await assert.rejects(freeServicePorts(() => {
    if (reservations.length === 2) throw new Error("fixture allocation failed");
    const server = createServer(); reservations.push(server); return server;
  }), /fixture allocation failed/);
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every(server => !server.listening));
});

function startupDiagnostics(output: string): string {
  return output.split("\n").filter(line => /error|failed|unavailable|exited|stopping/i.test(line))
    .slice(-20).join("\n").replace(/fixture-only-[a-z0-9-]+/gi, "[redacted fixture secret]");
}

test("dev startup diagnostics retain the port failure without echoing fixture secrets", () => {
  const diagnostics = startupDiagnostics("No Wave local development\nerror   Port 12345 is unavailable.\nerror   fixture-only-diagnostic-canary\n");
  assert.match(diagnostics, /Port 12345 is unavailable/);
  assert.match(diagnostics, /\[redacted fixture secret\]/);
  assert.doesNotMatch(diagnostics, /fixture-only|No Wave local development/);
});

for (const provider of ["sqlite", "postgres"] as const) {
  test(`${provider}: the default dev command starts API, worker and Web, delivering an idempotent private message within two seconds`, {
    timeout: 60_000, skip: provider === "postgres" && !process.env.TEST_DATABASE_URL && "Set TEST_DATABASE_URL to verify the default three-role dev chain on PostgreSQL.",
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "nw-dev-notifications-"));
    const filename = join(directory, "dev.sqlite");
    let database: NodeJS.ProcessEnv = { DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename };
    const postgres = provider === "postgres" ? await createIsolatedPostgresTestSchema(process.env.TEST_DATABASE_URL!) : null;
    if (postgres) {
      const [schema] = await postgres.sql.unsafe("SELECT current_schema() AS name");
      const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set("search_path", `${String(schema.name)},public`);
      database = { DATABASE_PROVIDER: "postgres", DATABASE_URL: url.toString() };
    } else {
      const db = createSqliteClient({ filename }); await runSqliteMigrations(db); db.close();
    }
    const [apiPort, workerPort, webPort] = await freeServicePorts();
    const apiUrl = `http://127.0.0.1:${apiPort}`, workerUrl = `http://127.0.0.1:${workerPort}`, webUrl = `http://127.0.0.1:${webPort}`;
    const child = spawn(process.execPath, [fileURLToPath(new URL("./dev.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", ...database,
        PORT: String(apiPort), OUTBOX_HEALTH_PORT: String(workerPort), WEB_PORT: String(webPort),
        AUTH_JWT_SECRET: "fixture-only-dev-notifications-secret-at-least-32-bytes", AUTH_JWT_ISSUER: apiUrl,
        AUTH_JWT_AUDIENCE: "dev-notifications", SHUTDOWN_GRACE_MS: "800", SHUTDOWN_CLEANUP_MS: "200" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = once(child, "close");
    try {
      const startupDeadline = Date.now() + 40_000;
      while (!output.includes("Ready.") && Date.now() < startupDeadline && child.exitCode === null) await delay(30);
      assert.ok(output.includes("Ready."), "the real default dev orchestrator must finish startup; diagnostics:\n" + startupDiagnostics(output));
      assert.equal((await fetch(webUrl + "/")).status, 200);
      const outcome = await runNotificationDeliverySmoke({ apiUrl, workerUrl, deliveryDeadlineMs: 2000 });
      assert.equal(outcome.event, "notification_delivery_smoke_passed");
      assert.equal(outcome.checks, 10);
      assert.ok(outcome.deliveryMs <= 2000);
      console.log(JSON.stringify({ provider, event: "default_dev_notification_verified", deliveryMs: outcome.deliveryMs }));
      assert.doesNotMatch(output, /notification-smoke-private-|fixture-only-dev-notifications-secret/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const result = await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); return exited; })]);
      try {
        assert.deepEqual(result, [0, null], "the orchestrator and every role must stop successfully; lifecycle diagnostics:\n" + output.split("\n").filter(line => /error|failed|shutdown|exited|stopping/i.test(line)).slice(-30).join("\n"));
        for (const origin of [apiUrl, workerUrl, webUrl]) await assert.rejects(fetch(origin + "/", { signal: AbortSignal.timeout(500) }));
      } finally { await postgres?.cleanup(); await rm(directory, { recursive: true, force: true }); }
    }
  });
}

// Fault the actual application under each watch shell, not a stand-in HTTP
// fixture. /proc is used only by this Linux fault-injection harness; production
// process supervision uses POSIX process groups / Windows taskkill instead.
for (const fault of ["api", "worker", "web", "worker-stalled"] as const) {
  test(`the real default three-role dev chain fails closed when ${fault} fails after readiness`, {
    timeout: 60_000, skip: process.platform !== "linux" && "Linux /proc process-identity fault harness.",
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "nw-dev-fault-"));
    const filename = join(directory, "fault.sqlite");
    const db = createSqliteClient({ filename }); await runSqliteMigrations(db); db.close();
    const [apiPort, workerPort, webPort] = await freeServicePorts();
    const child = spawn(process.execPath, [fileURLToPath(new URL("./dev.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1",
        DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename,
        PORT: String(apiPort), OUTBOX_HEALTH_PORT: String(workerPort), WEB_PORT: String(webPort),
        AUTH_JWT_SECRET: "fixture-only-dev-fault-secret-at-least-32-bytes",
        AUTH_JWT_ISSUER: `http://127.0.0.1:${apiPort}`, AUTH_JWT_AUDIENCE: "dev-fault",
        DEV_RECOVERY_TIMEOUT_MS: "1000", SHUTDOWN_GRACE_MS: "500", SHUTDOWN_CLEANUP_MS: "100" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = once(child, "close");
    const roleGroups: number[] = [];
    try {
      const deadline = performance.now() + 40_000;
      while (!output.includes("Ready.") && performance.now() < deadline && child.exitCode === null) await delay(30);
      assert.ok(output.includes("Ready."), "all real roles must be ready before injecting a fault; diagnostics:\n" + startupDiagnostics(output));
      const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,ppid="]);
      const processes = stdout.trim().split("\n").map(line => {
        const [pid, parent] = line.trim().split(/\s+/).map(Number); return { pid: pid!, parent: parent! };
      });
      const children = processes.filter(row => row.parent === child.pid);
      assert.equal(children.length, 3);
      roleGroups.push(...children.map(row => row.pid));
      const role = fault === "worker-stalled" ? "worker" : fault;
      let target: number | undefined;
      for (const candidate of children) {
        const environment = Object.fromEntries((await readFile(`/proc/${candidate.pid}/environ`, "utf8")).split("\0").filter(Boolean).map(entry => {
          const separator = entry.indexOf("="); return [entry.slice(0, separator), entry.slice(separator + 1)];
        }));
        const matches = role === "web" ? environment.PORT === String(webPort)
          : environment.SERVICE_ROLE === (role === "api" ? "api" : "notification-worker");
        if (!matches) continue;
        // For API/worker, kill or freeze the inner application while leaving
        // Node's watcher alive, the precise failure a child-exit-only guard misses.
        const application = role === "web" ? candidate : processes.find(row => row.parent === candidate.pid);
        assert.ok(application, "the selected service must have a real application process");
        target = application.pid;
      }
      assert.ok(target);
      const began = performance.now();
      process.kill(target, fault === "worker-stalled" ? "SIGSTOP" : "SIGKILL");
      const result = await Promise.race([exited, delay(8000, undefined, { ref: false }).then(() => { throw new Error("A real service fault left the dev command running."); })]);
      assert.deepEqual(result, [1, null]);
      assert.ok(performance.now() - began < 8000);
      assert.match(output, fault === "worker-stalled" ? /did not recover readiness/ : /stopped behind its watcher|exited unexpectedly/);
      for (const port of [apiPort, workerPort, webPort]) await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }));
      assert.doesNotMatch(output, /fixture-only-dev-fault-secret/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await Promise.race([exited, delay(3500)]); }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // Safety net for failing assertions: these detached groups belong only to
      // this invocation. Successful assertions above precede this forced cleanup.
      for (const pid of roleGroups) { try { process.kill(-pid, "SIGKILL"); } catch { /* already reaped */ } }
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
