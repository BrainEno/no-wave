import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "../persistence/sqlite.ts";

const cases = [
  { role: "api", source: "uncaught" }, { role: "api", source: "rejection" }, { role: "api", source: "listener" },
  { role: "notification-worker", source: "uncaught" }, { role: "notification-worker", source: "rejection" },
  { role: "notification-worker", source: "listener" }, { role: "notification-worker", source: "metrics-listener" },
] as const;
for (const { role, source } of cases) {
  test(`${role}: an ${source} process fault drains boundedly, closes persistence once and never prints exception payloads`, { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "nw-process-fault-"));
    const filename = join(directory, "fault.sqlite");
    const db = createSqliteClient({ filename }); await runSqliteMigrations(db); db.close();
    const injector = join(directory, "inject.ts");
    const listenerFault = source === "listener" || source === "metrics-listener";
    await writeFile(injector, listenerFault ? `import {Server} from 'node:http';
      const listen=Server.prototype.listen;let selected;
      Server.prototype.listen=function(...args){
        this.once('listening',()=>{const address=this.address();if(address?.port===Number(process.env.${source === "metrics-listener" ? "OUTBOX_METRICS_PORT" : "PORT"}))selected=this;});
        return listen.apply(this,args);
      };
      process.once('message',()=>{process.disconnect();selected.close();selected.closeAllConnections();});
    ` : `process.once('message',()=>{
      process.disconnect();
      const error=new Error('process-fault-private-payload-canary postgres://private:password@host/database');
      error.name='DriverFailure';
      ${source === "uncaught" ? "queueMicrotask(()=>{throw error;});" : "void Promise.reject(error);"}
    });\n`);
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    let metricsPort = 0;
    if (source === "metrics-listener") {
      const metrics = createServer(); metrics.listen(0, "127.0.0.1"); await once(metrics, "listening");
      const second = metrics.address(); assert.ok(second && typeof second !== "string"); metricsPort = second.port;
      await new Promise<void>(resolve => metrics.close(() => resolve()));
    }
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, ["--import", pathToFileURL(injector).href, fileURLToPath(new URL("../service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1", SERVICE_ROLE: role, DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename,
        PORT: String(address.port), HOST: "127.0.0.1", OUTBOX_HEALTH_PORT: String(address.port), OUTBOX_METRICS_PORT: String(metricsPort),
        SHUTDOWN_GRACE_MS: "500", SHUTDOWN_CLEANUP_MS: "150", AUTH_JWT_SECRET: "fixture-only-process-fault-secret-over-thirty-two-bytes",
        AUTH_JWT_ISSUER: origin, AUTH_JWT_AUDIENCE: "process-fault" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const exited = once(child, "close");
    let socket: ReturnType<typeof connect> | null = null;
    try {
      const deadline = performance.now() + 8000;
      let ready = false;
      while (!ready && performance.now() < deadline && child.exitCode === null) {
        try { ready = (await fetch(origin + "/ready", { signal: AbortSignal.timeout(250) })).status === 200; } catch { /* still starting */ }
        if (!ready) await delay(20);
      }
      assert.equal(ready, true, "inject only after the real role has completed startup");
      socket = connect(address.port, "127.0.0.1");
      socket.on("error", () => {}); await once(socket, "connect");
      socket.write("GET /health HTTP/1.1\r\nHost: fixture\r\nX-Unfinished:");
      await delay(20);
      const started = performance.now();
      child.send("fault");
      const result = await Promise.race([exited, delay(1800, undefined, { ref: false }).then(() => { throw new Error("A fatal process fault exceeded its cleanup deadline."); })]);
      assert.deepEqual(result, [1, null]);
      assert.ok(performance.now() - started < 1500);
      const records = output.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
      const prefix = role === "api" ? "api" : "notification_worker";
      assert.equal(records.filter(row => row.event === `${prefix}_persistence_closed`).length, 1);
      if (listenerFault) {
        const event = role === "api" ? "api_listener_closed" : source === "metrics-listener" ? "outbox_metrics_listener_closed" : "worker_health_listener_closed";
        assert.equal(records.filter(row => row.event === event).length, 1);
      } else {
        const fault = records.filter(row => row.event === `${prefix}_process_failure`);
        assert.equal(fault.length, 1); assert.equal(fault[0]!.errorName, "DriverFailure");
        assert.equal(fault[0]!.source, source === "uncaught" ? "uncaught_exception" : "unhandled_rejection");
      }
      assert.equal(records.filter(row => row.event === `${prefix}_shutdown_complete`).length, 1);
      assert.doesNotMatch(output, /process-fault-private-payload-canary|postgres:\/\/|fixture-only-process-fault-secret/);
      await assert.rejects(fetch(origin + "/health", { signal: AbortSignal.timeout(300) }));
    } finally {
      socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited; await rm(directory, { recursive: true, force: true });
    }
  });
}

test("the fatal boundary hard-exits inside one deadline even if shutdown hangs, and observer failures cannot restore a successful status", { timeout: 8000 }, async () => {
  const module = pathToFileURL(fileURLToPath(new URL("./process-failures.ts", import.meta.url))).href;
  for (const mode of ["hang", "reject", "observer"] as const) {
    const script = `import {guardProcessFailures} from ${JSON.stringify(module)};
let called=0;
guardProcessFailures({prefix:'api',deadlineMs:150,
  shutdown:()=>{called++;${mode === "hang" ? "return new Promise(()=>{});" : mode === "reject" ? "throw new Error('private-cleanup-canary');" : "return Promise.resolve();"}},
  log:entry=>{${mode === "observer" ? "throw new Error('private-observer-canary');" : "console.log(JSON.stringify(entry));"}}});
const error=new Error('private-process-canary');error.name='bad-class/private-canary';
process.emit('unhandledRejection',error,Promise.resolve());
process.emit('uncaughtException',error,'uncaughtException');
process.on('exit',code=>console.log(JSON.stringify({called,code})));`;
    const started = performance.now();
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: process.env.PATH }, timeout: 2500 }).then(
      () => { throw new Error("A fatal process boundary returned success."); },
      (error: unknown) => error as Error & { code: number; stdout: string; stderr: string },
    );
    assert.equal(result.code, 1); assert.ok(performance.now() - started < 1500);
    assert.match(result.stdout, /"called":1,"code":1/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-/);
    if (mode === "hang") assert.match(result.stdout, /api_process_failure_deadline_reached/);
    if (mode === "reject") assert.match(result.stdout, /api_process_failure_cleanup_failed/);
  }
});
