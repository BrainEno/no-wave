import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "../persistence/sqlite.ts";

async function until<T>(read: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(20);
  }
  throw new Error("The child did not report the expected lifecycle event.");
}
async function stopped(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return Promise.race([once(child, "exit").then(() => true), delay(timeoutMs).then(() => false)]);
}

test("SIGTERM bounds a real API's unfinished body, closes persistence once and does not report a forced drain as graceful", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-api-lifecycle-"));
  const filename = join(directory, "api.sqlite");
  const db = createSqliteClient({ filename });
  await runSqliteMigrations(db);
  db.close();
  const reservation = createServer();
  reservation.listen(0, "0.0.0.0");
  await once(reservation, "listening");
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== "string");
  const reservedPort = reserved.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [new URL("../server.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename,
      AUTH_JWT_SECRET: "fixture-only-lifecycle-auth-secret-at-least-32-bytes", AUTH_JWT_ISSUER: "http://localhost", AUTH_JWT_AUDIENCE: "fixture",
      PORT: String(reservedPort), HOST: "0.0.0.0", SHUTDOWN_GRACE_MS: "400", SHUTDOWN_CLEANUP_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const records: Record<string, unknown>[] = [];
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const parse = () => {
    for (const line of output.split("\n")) {
      try { const value = JSON.parse(line); if (value && typeof value === "object") records.push(value); } catch {}
    }
    output = "";
  };
  let socket: ReturnType<typeof connect> | null = null;
  try {
    const port = await until(() => {
      parse();
      return records.find(record => record.event === "api.runtime_compatibility" && Number(record.port) > 0)?.port as number ?? null;
    });
    socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(`POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{`);
    await delay(40);
    const start = performance.now();
    child.kill("SIGTERM");
    assert.equal(await stopped(child, 1800), true, "an unfinished request must not pin the API until the host kills it");
    assert.ok(performance.now() - start < 1500);
    parse();
    assert.equal(records.filter(record => record.event === "api_persistence_closed").length, 1);
    const complete = records.find(record => record.event === "api_shutdown_complete");
    assert.equal(complete?.forced, true);
    assert.equal(complete?.cleanupSucceeded, true);
    assert.equal(child.exitCode, 0, "closing a timed-out client is recoverable if durable resources close successfully");
    const reopened = createSqliteClient({ filename });
    assert.equal(reopened.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    reopened.close();
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    await rm(directory, { recursive: true, force: true });
  }
});
