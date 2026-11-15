import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createStartupDeadline } from "./startup-deadline.ts";

test("bootstrap deadlines default to thirty seconds, expire once, and are cancelled by successful startup or a requested stop", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entries: Array<Record<string, unknown>> = [];
  let stops = 0;
  const options = { env: {}, prefix: "api" as const, log: (entry: Record<string, unknown>) => entries.push(entry), onTimeout: () => { stops += 1; } };
  const cancel = createStartupDeadline(options);
  t.mock.timers.tick(29_999);
  assert.equal(stops, 0);
  t.mock.timers.tick(1);
  assert.equal(stops, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.event, "api_startup_deadline_reached");
  assert.equal(entries[0]!.timeoutMs, 30_000);
  cancel(); cancel(); t.mock.timers.tick(120_000);
  assert.equal(stops, 1);
  const complete = createStartupDeadline({ ...options, env: { SERVICE_STARTUP_TIMEOUT_MS: "100" } });
  complete(); complete(); t.mock.timers.tick(101);
  assert.equal(stops, 1);
  assert.equal(entries.length, 1);
});

test("a broken startup observer cannot suppress teardown and invalid settings never echo their values", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let stopped = 0;
  const options = { prefix: "notification_worker" as const, onTimeout: () => { stopped += 1; },
    log: () => { throw new Error("private-startup-observer-canary"); } };
  for (const value of ["99", "120001", "-100", "0", "0.5", "1e3", "private-startup-setting-canary"]) {
    assert.throws(() => createStartupDeadline({ ...options, env: { SERVICE_STARTUP_TIMEOUT_MS: value } }), error => {
      assert.ok(error instanceof RangeError); assert.match(error.message, /SERVICE_STARTUP_TIMEOUT_MS/);
      assert.doesNotMatch(error.message, /private-/); return true;
    });
  }
  const cancel = createStartupDeadline({ ...options, env: { SERVICE_STARTUP_TIMEOUT_MS: "100" } });
  t.mock.timers.tick(100);
  assert.equal(stopped, 1);
  cancel(); t.mock.timers.tick(1000);
  assert.equal(stopped, 1);
});

test("an unresolved startup with no other active handle stays alive until its deadline instead of silently exiting zero", async () => {
  const module = pathToFileURL(fileURLToPath(new URL("./startup-deadline.ts", import.meta.url))).href;
  const script = `import {createStartupDeadline} from ${JSON.stringify(module)};
createStartupDeadline({env:{SERVICE_STARTUP_TIMEOUT_MS:'100'},prefix:'api',
  log:entry=>console.log(JSON.stringify(entry)),onTimeout:()=>{process.exitCode=1;}});
void new Promise(()=>{});`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH }, timeout: 2500,
  }).then(() => { throw new Error("An uncompleted startup returned success."); },
    (error: unknown) => error as Error & { code: number; stdout: string; stderr: string });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"event":"api_startup_deadline_reached"/);
  assert.match(result.stdout, /"timeoutMs":100/);
});
