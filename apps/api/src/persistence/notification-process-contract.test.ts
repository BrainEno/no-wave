import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { integrityOptions, integrityProviders, notificationIntegrityFixture } from "./test-support/notification-integrity-fixture.ts";

const execute = promisify(execFile);
const entry = (name: string) => new URL(`./notification-${name}.ts`, import.meta.url).pathname;
function cleanEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", NODE_NO_WARNINGS: "1" };
}
async function freePort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function jsonLines(output: string): Array<Record<string, unknown>> {
  return output.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
}

for (const provider of integrityProviders) {
  test(`${provider}: real drain and worker processes honor quarantine settings, scrape metrics and preserve private payloads`, { ...integrityOptions(provider), timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "nw-notification-process-"));
    const f = await notificationIntegrityFixture(t, provider, { sqliteFile: join(directory, "worker.sqlite") });
    t.after(() => rm(directory, { recursive: true, force: true }));
    let database: NodeJS.ProcessEnv;
    if (f.db) database = { DATABASE_PROVIDER: "sqlite", DATABASE_PATH: join(directory, "worker.sqlite") };
    else {
      const [row] = await f.query("SELECT current_schema() AS name");
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set("search_path", `${String(row.name)},public`);
      database = { DATABASE_PROVIDER: "postgres", DATABASE_URL: url.toString() };
    }
    const base = { ...cleanEnvironment(), ...database, OUTBOX_MAX_ATTEMPTS: "1", OUTBOX_RETRY_DELAY_SECONDS: "2", OUTBOX_MAX_RETRY_DELAY_SECONDS: "8" };
    const poison = await f.enqueue("private-canary-process-payload");
    await f.query("UPDATE outbox_events SET event_type = ? WHERE id = ?", ["unsupported.notification", poison.eventId]);
    const first = await f.enqueue("healthy-first-process");
    const drain = await execute(process.execPath, [entry("drain")], { env: base, timeout: 15_000 });
    const completed = jsonLines(drain.stdout + drain.stderr).find(line => line.event === "outbox_drain_completed");
    assert.ok(completed);
    assert.equal(completed.claimed, 2);
    assert.equal(completed.delivered, 1);
    assert.equal(completed.deadLettered, 1);
    assert.equal(completed.stopReason, "empty");
    const failure = jsonLines(drain.stderr).find(line => line.event === "outbox_event_failed");
    assert.equal(failure!.level, "error");
    assert.equal(failure!.deadLettered, true);
    assert.equal(failure!.retryScheduled, false);
    assert.equal(failure!.errorName, "TypeError");
    const again = await execute(process.execPath, [entry("drain")], { env: base, timeout: 15_000 });
    assert.equal(jsonLines(again.stdout).find(line => line.event === "outbox_drain_completed")!.claimed, 0);
    const secondPoison = await f.enqueue("private-canary-worker-payload");
    await f.query("UPDATE outbox_events SET event_type = ? WHERE id = ?", ["unsupported.notification", secondPoison.eventId]);
    const second = await f.enqueue("healthy-second-process");
    const port = await freePort();
    const child = spawn(process.execPath, [entry("worker")], { env: { ...base, OUTBOX_POLL_INTERVAL_MS: "100",
      OUTBOX_METRICS_PORT: String(port), OUTBOX_METRICS_HOST: "127.0.0.1", OUTBOX_METRICS_REFRESH_INTERVAL_MS: "1000" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const exited = once(child, "exit");
    try {
      const deadline = Date.now() + 15_000;
      let metrics = "";
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("The notification worker exited before its metrics sample.");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(1000) });
          assert.equal(response.status, 200);
          assert.match(response.headers.get("cache-control")!, /no-store/);
          metrics = await response.text();
          if (/^api_outbox_dead_letter_events 2$/m.test(metrics)) break;
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
        }
        await delay(30);
      }
      assert.match(metrics, /^api_outbox_dead_letter_events 2$/m);
      assert.match(metrics, /^api_outbox_pending_events 0$/m);
      assert.match(metrics, /^api_outbox_events_delivered_total 1$/m);
      const notFound = await fetch(`http://127.0.0.1:${port}/not-metrics`);
      assert.equal(notFound.status, 404);
      child.kill("SIGTERM");
      const [code, signal] = await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw new Error("The notification worker did not stop cleanly."); })]);
      assert.equal(code, 0);
      assert.equal(signal, null);
      const started = jsonLines(stdout).find(line => line.event === "worker_started")!;
      assert.equal(started.maxAttempts, 1);
      assert.equal(started.maxRetryDelaySeconds, 8);
      assert.ok(jsonLines(stdout).some(line => line.event === "worker_stopping"));
      assert.ok(jsonLines(stderr).some(line => line.deadLettered === true));
      const notifications = await f.store.listNotifications({ actorId: "integrity-recipient", limit: 100 });
      assert.deepEqual(notifications.map(row => row.eventKey).sort(), [`message:${first.message.id}`, `message:${second.message.id}`].sort());
      assert.deepEqual(await f.store.outboxBacklog(), { pendingEvents: 0, deadLetterEvents: 2, oldestPendingAgeMs: 0 });
      assert.doesNotMatch(drain.stdout + drain.stderr + again.stdout + again.stderr + stdout + stderr + metrics, /private-canary|postgres:\/\/|DATABASE_URL|payload_hash/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  });
}

test("both notification entry points reject retry configuration before opening an invalid database", async () => {
  for (const name of ["drain", "worker"]) {
    for (const invalid of [
      { OUTBOX_MAX_ATTEMPTS: "0" }, { OUTBOX_MAX_ATTEMPTS: "101" }, { OUTBOX_MAX_ATTEMPTS: "1.5" },
      { OUTBOX_MAX_RETRY_DELAY_SECONDS: "0" }, { OUTBOX_RETRY_DELAY_SECONDS: "31", OUTBOX_MAX_RETRY_DELAY_SECONDS: "30" },
    ]) {
      try {
        await execute(process.execPath, [entry(name)], { env: { ...cleanEnvironment(), DATABASE_PROVIDER: "invalid-before-database", ...invalid }, timeout: 5000 });
        assert.fail("invalid worker retry settings must exit nonzero");
      } catch (error: unknown) {
        assert.ok(error && typeof error === "object" && "code" in error && "stderr" in error);
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /OUTBOX_MAX_ATTEMPTS|maxRetryDelaySeconds|OUTBOX_MAX_RETRY_DELAY_SECONDS/);
        assert.doesNotMatch(String(error.stderr), /DATABASE_PROVIDER|invalid-before-database/);
      }
    }
  }
});
