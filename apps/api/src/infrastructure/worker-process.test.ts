import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "../persistence/test-support/notification-integrity-fixture.ts";

async function freePort(): Promise<number> {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  return address.port;
}
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const result = await read(); if (result !== null) return result; await delay(20); }
  throw new Error("The real worker did not reach the expected state before its test deadline.");
}
function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../service.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", SERVICE_ROLE: "notification-worker",
      SHUTDOWN_GRACE_MS: "600", SHUTDOWN_CLEANUP_MS: "200", AUTH_JWT_SECRET: "short-private-worker-canary", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const records = () => output.split("\n").filter(line => line.startsWith("{")).flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const stop = async () => {
    child.kill("SIGTERM");
    return Promise.race([exited, delay(1800, undefined, { ref: false }).then(() => { throw new Error("Worker termination exceeded its process budget."); })]);
  };
  const cleanup = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; };
  return { child, exited, stop, cleanup, records, get output() { return output; } };
}
async function databaseEnvironment(fixture: Awaited<ReturnType<typeof notificationIntegrityFixture>>, filename: string): Promise<NodeJS.ProcessEnv> {
  if (fixture.db) return { DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename };
  const [row] = await fixture.query("SELECT current_schema() AS name");
  const url = new URL(process.env.TEST_DATABASE_URL!); url.searchParams.set("search_path", `${String(row.name)},public`);
  return { DATABASE_PROVIDER: "postgres", DATABASE_URL: url.toString() };
}

for (const provider of integrityProviders) {
  test(`${provider}: the image role delivers durable work without API credentials and interrupts a sixty-second idle poll on SIGTERM`, { ...integrityOptions(provider), timeout: 20_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "nw-worker-lifecycle-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "worker.sqlite");
    const f = await notificationIntegrityFixture(t, provider, { sqliteFile: filename });
    const message = await f.enqueue("private-process-delivery-canary");
    const port = await freePort();
    const worker = start({ ...await databaseEnvironment(f, filename), OUTBOX_HEALTH_PORT: String(port), OUTBOX_POLL_INTERVAL_MS: "60000" });
    const origin = `http://127.0.0.1:${port}`;
    try {
      await waitFor(async () => worker.records().some(row => row.event === "worker_ready") ? true : null);
      // worker_ready means the role can serve readiness, not that its first
      // asynchronous PostgreSQL delivery has already reached the idle poll.
      // Observe that exact state before testing SIGTERM from a sixty-second
      // idle wait; keep all readiness, delivery and shutdown assertions below.
      const body = await waitFor(async () => {
        const ready = await fetch(origin + "/ready?private-query-canary");
        assert.equal(ready.status, 200);
        const candidate = await ready.json();
        return candidate.phase === "idle" && candidate.completedBatches >= 1 ? candidate : null;
      });
      assert.equal(body.service, "notification-worker");
      assert.equal(body.phase, "idle");
      assert.ok(body.completedBatches >= 1);
      assert.equal((await fetch(origin + "/api/v1/health")).status, 404, "a worker role must not expose the API");
      const notifications = await f.store.listNotifications({ actorId: "integrity-recipient", limit: 10 });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.eventKey, `message:${message.message.id}`);
      const began = performance.now();
      assert.deepEqual(await worker.stop(), [0, null]);
      assert.ok(performance.now() - began < 1300);
      const records = worker.records();
      assert.equal(records.filter(row => row.event === "notification_worker_persistence_closed").length, 1);
      const completed = records.find(row => row.event === "notification_worker_shutdown_complete");
      assert.equal(completed?.forced, false);
      assert.equal(completed?.cleanupSucceeded, true);
      assert.doesNotMatch(worker.output + JSON.stringify(body), /short-private-worker-canary|private-process-delivery-canary|private-query-canary|postgres:\/\//);
      assert.deepEqual(await f.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 0, oldestPendingAgeMs: 0 });
    } finally { await worker.cleanup(); }
  });
}

test("postgres: a delivery blocked by a real conversation row lock becomes unready, exits nonzero within budget, and is recovered once after lease expiry", { ...integrityOptions("postgres"), timeout: 30_000 }, async t => {
  const f = await notificationIntegrityFixture(t, "postgres");
  const pending = await f.enqueue("private-row-lock-canary");
  const environment = await databaseEnvironment(f, "unused");
  let unlock!: () => void, acquired!: () => void;
  const hold = new Promise<void>(resolve => { unlock = resolve; });
  const locked = new Promise<void>(resolve => { acquired = resolve; });
  const transaction = f.sql!.begin(async tx => {
    await tx.unsafe("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [pending.message.conversationId]);
    acquired(); await hold;
  });
  await locked;
  const port = await freePort();
  const worker = start({ ...environment, OUTBOX_HEALTH_PORT: String(port), OUTBOX_POLL_INTERVAL_MS: "100", OUTBOX_LEASE_SECONDS: "1" });
  try {
    await waitFor(async () => {
      const [row] = await f.query("SELECT attempts,lease_token FROM outbox_events WHERE id = ?", [pending.eventId]);
      return row?.lease_token && row.attempts === 1 ? true : null;
    });
    const ready = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      const body = await response.json();
      return response.status === 503 && body.reason === "batch_overdue" ? body : null;
    });
    assert.equal(ready.phase, "delivering");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    const began = performance.now();
    assert.deepEqual(await worker.stop(), [1, null]);
    assert.ok(performance.now() - began < 1300);
    const completed = worker.records().find(row => row.event === "notification_worker_shutdown_complete");
    assert.equal(completed?.forced, true);
    assert.equal(completed?.cleanupTimedOut, true);
    assert.equal((await f.store.listNotifications({ actorId: "integrity-recipient", limit: 10 })).length, 0);
  } finally { unlock(); await transaction; await worker.cleanup(); }
  const recovered = start({ ...environment, OUTBOX_HEALTH_PORT: String(port), OUTBOX_POLL_INTERVAL_MS: "100", OUTBOX_LEASE_SECONDS: "10" });
  try {
    await waitFor(async () => (await f.store.outboxBacklog()).pendingEvents === 0 ? true : null);
    assert.deepEqual(await recovered.stop(), [0, null]);
    const notifications = await f.store.listNotifications({ actorId: "integrity-recipient", limit: 10 });
    assert.deepEqual(notifications.map(row => row.eventKey), [`message:${pending.message.id}`]);
    const [event] = await f.query("SELECT attempts,delivered_at,lease_token,dead_lettered_at FROM outbox_events WHERE id = ?", [pending.eventId]);
    assert.equal(event.attempts, 2); assert.ok(event.delivered_at); assert.equal(event.lease_token, null); assert.equal(event.dead_lettered_at, null);
    assert.doesNotMatch(worker.output + recovered.output, /private-row-lock-canary|short-private-worker-canary|postgres:\/\//);
  } finally { await recovered.cleanup(); }
});

test("sqlite: a busy durable backlog yields between batches so health, optional sampling and SIGTERM work before the queue is empty", { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "nw-worker-busy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "busy.sqlite");
  const f = await notificationIntegrityFixture(t, "sqlite", { sqliteFile: filename });
  for (let index = 0; index < 3000; index++) await f.enqueue(`private-busy-backlog-canary-${index}`);
  const port = await freePort(), metricsPort = await freePort();
  const worker = start({ DATABASE_PROVIDER: "sqlite", DATABASE_PATH: filename, OUTBOX_HEALTH_PORT: String(port),
    OUTBOX_METRICS_PORT: String(metricsPort), OUTBOX_BATCH_LIMIT: "1", OUTBOX_POLL_INTERVAL_MS: "60000" });
  try {
    await waitFor(async () => worker.output.includes('"event":"worker_ready"') ? true : null);
    const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200);
    assert.ok((await f.store.outboxBacklog()).pendingEvents > 0, "readiness must be served before all synchronous SQLite batches drain");
    const metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics?source=busy-probe`, { signal: AbortSignal.timeout(1500) })).text();
    assert.match(metrics, /^notification_worker_backlog_available 1$/m);
    const began = performance.now();
    assert.deepEqual(await worker.stop(), [0, null]);
    assert.ok(performance.now() - began < 1300);
    assert.ok((await f.store.outboxBacklog()).pendingEvents > 0, "stop must interrupt a nonempty queue instead of waiting for every batch");
    assert.equal(worker.records().filter(row => row.event === "notification_worker_persistence_closed").length, 1);
    assert.doesNotMatch(worker.output + metrics, /private-busy-backlog-canary|short-private-worker-canary/);
  } finally { await worker.cleanup(); }
});
