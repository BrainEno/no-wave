import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createSqliteClient, runSqliteMigrations } from "../apps/api/src/persistence/sqlite.ts";

const execute = promisify(execFile);
test("documented worker and drain package commands load root env files with shell > .env.local > .env precedence", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "nw-worker-env-"));
  const cwd = join(directory, "apps/api"); await mkdir(cwd, { recursive: true });
  const filename = join(directory, "shared.sqlite");
  const db = createSqliteClient({ filename }); await runSqliteMigrations(db); db.close();
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  await writeFile(join(directory, ".env"), "DATABASE_PROVIDER=invalid-base-file\nOUTBOX_POLL_INTERVAL_MS=invalid-base-file\n");
  await writeFile(join(directory, ".env.local"), `DATABASE_PROVIDER=sqlite\nDATABASE_PATH=invalid-shell-override-canary\nOUTBOX_POLL_INTERVAL_MS=60000\nOUTBOX_HEALTH_PORT=${address.port}\n`);
  const manifest = JSON.parse(await readFile(new URL("../apps/api/package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  const args = (name: string) => {
    const [executable, ...tokens] = manifest.scripts[name]!.split(" ");
    assert.equal(executable, "node");
    const entry = tokens.pop()!;
    return [...tokens, fileURLToPath(new URL(`../apps/api/${entry}`, import.meta.url))];
  };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", DATABASE_PATH: filename };
  const child = spawn(process.execPath, args("worker:notifications"), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const deadline = performance.now() + 5000;
    while (!output.includes('"event":"worker_ready"') && performance.now() < deadline && child.exitCode === null) await delay(20);
    assert.match(output, /"event":"worker_ready"/);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 200);
    child.kill("SIGTERM");
    assert.deepEqual(await Promise.race([exited, delay(1500, undefined, { ref: false }).then(() => { throw new Error("Worker env fixture failed to stop."); })]), [0, null]);
    const drain = await execute(process.execPath, args("drain:notifications"), { cwd, env, timeout: 5000 });
    assert.match(drain.stdout, /outbox_drain_completed/);
    assert.match(drain.stdout, /"claimed":0/);
    assert.doesNotMatch(output + drain.stdout + drain.stderr, /invalid-base-file|invalid-shell-override-canary/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited; await rm(directory, { recursive: true, force: true });
  }
});
