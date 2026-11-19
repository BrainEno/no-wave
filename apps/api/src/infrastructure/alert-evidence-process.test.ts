import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { handoffFixture } from "./test-support/alert-handoff-fixture.ts";
import { alertEvidenceWorkspace } from "./test-support/alert-evidence-workspace.ts";
import { handoffHash } from "../application/alert-handoff-protocol.ts";
import { parseAlertEvidenceTrust } from "./alert-evidence-config.ts";

const entry = fileURLToPath(
  new URL("./alert-evidence-command.ts", import.meta.url),
);
const handoffEntry = fileURLToPath(
  new URL("./alert-handoff-command.ts", import.meta.url),
);
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_NO_WARNINGS: "1",
  DATABASE_PROVIDER: "must-not-open",
  DATABASE_URL: "evidence-db-canary",
  AUTH_JWT_SECRET: "evidence-auth-canary",
};
function run(args: string[], expected = 0, target = entry) {
  const result = spawnSync(process.execPath, [target, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected, result.stderr);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /evidence-(db|auth|env-file)-canary|signingKey|privateKey|senderKey|receiverKey|metricsUrl/,
  );
  return JSON.parse(result.stdout || result.stderr) as Record<string, unknown>;
}

test(
  "real v1 handoff producers feed public-only review and comparison after all synthetic private journals and keys are removed",
  { timeout: 20_000 },
  (t) => {
    const f = handoffFixture(),
      publicFiles = alertEvidenceWorkspace(t);
    const privateDirectory = mkdtempSync(
      join(tmpdir(), "nw-evidence-signers-"),
    );
    chmodSync(privateDirectory, 0o700);
    t.after(() => rmSync(privateDirectory, { recursive: true, force: true }));
    const path = (name: string) => join(privateDirectory, name + ".json");
    const put = (file: string, value: unknown) =>
      writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
    const base = Date.now() - 120_000;
    put(path("sender"), f.senderDocument);
    put(path("inbox"), f.inboxDocument);
    put(path("monitor"), {
      version: 1,
      targets: f.monitorConfig.targets,
      rules: {
        target_unavailable: { forMs: 0, resolveMs: 0, repeatMs: 30_000 },
      },
    });
    put(path("alerts"), f.observe(null, base));
    const source = [
      "--config",
      path("sender"),
      "--state",
      path("sender-state"),
      "--monitor-config",
      path("monitor"),
      "--monitor-state",
      path("alerts"),
    ];
    const receiver = [
      "--config",
      path("inbox"),
      "--state",
      path("inbox-state"),
    ];
    const publicPath = (name: string) =>
      join(publicFiles.directory, name + ".json");
    const items: { kind: string; file: string; sha256: string }[] = [];
    for (let sequence = 1; sequence <= 2; sequence++) {
      if (sequence === 2)
        put(
          path("alerts"),
          f.observe(
            JSON.parse(readFileSync(path("alerts"), "utf8")),
            base + 60_000,
          ),
        );
      const batch = publicPath("actual-batch-" + sequence),
        receipt = publicPath("actual-receipt-" + sequence);
      run(["prepare", ...source, "--output", batch], 0, handoffEntry);
      run(
        ["receive", ...receiver, "--batch", batch, "--output", receipt],
        0,
        handoffEntry,
      );
      run(["settle", ...source, "--receipt", receipt], 0, handoffEntry);
      for (const [kind, file] of [
        ["batch", batch],
        ["receipt", receipt],
      ])
        items.push({
          kind: kind!,
          file: file!.split("/").at(-1)!,
          sha256: createHash("sha256")
            .update(readFileSync(file!))
            .digest("hex"),
        });
    }
    run(
      [
        "profile",
        "--config",
        path("sender"),
        "--output",
        publicPath("actual-profile"),
      ],
      0,
      handoffEntry,
    );
    const profile = JSON.parse(
      readFileSync(publicPath("actual-profile"), "utf8"),
    );
    publicFiles.put("trust.json", {
      version: 1,
      role: "evidence-review",
      profiles: [profile],
    });
    publicFiles.put("before.json", {
      version: 1,
      artifacts: items.slice(0, 2),
    });
    publicFiles.put("after.json", { version: 1, artifacts: items });
    const expectedBatch = JSON.parse(
      readFileSync(publicPath("actual-batch-2"), "utf8"),
    );
    const expectedReceipt = JSON.parse(
      readFileSync(publicPath("actual-receipt-2"), "utf8"),
    );
    const trust = parseAlertEvidenceTrust({
      version: 1,
      role: "evidence-review",
      profiles: [profile],
    });
    publicFiles.put("requirements.json", {
      version: 1,
      role: "evidence-requirements",
      trustFingerprint: trust.fingerprint,
      checkpoints: [
        {
          streamId: expectedBatch.streamId,
          sequence: 2,
          batchId: expectedBatch.id,
          receiptId: handoffHash(expectedReceipt),
          coverage: "prefix",
        },
      ],
    });
    rmSync(privateDirectory, { recursive: true });
    const before = publicFiles.snapshot();
    assert.equal(run(publicFiles.review).event, "alert_evidence_review");
    assert.equal(run(publicFiles.compare).change, "extended");
    const selection = [
      "--trust",
      publicFiles.trust,
      "--manifest",
      publicFiles.after,
    ];
    const checked = run([
      "check",
      ...selection,
      "--requirements",
      publicPath("requirements"),
    ]);
    assert.equal(checked.requirementsSatisfied, true);
    const first = run(["trace", ...selection, "--limit", "1"]);
    assert.equal(typeof first.continuation, "string");
    const last = run([
      "trace",
      ...selection,
      "--limit",
      "1",
      "--after",
      String(first.continuation),
    ]);
    assert.equal(last.continuation, null);
    assert.deepEqual(publicFiles.snapshot(), before);
  },
);

test(
  "independent review processes share no writer lock and produce the same evidence identity",
  { timeout: 10_000 },
  async (t) => {
    const f = alertEvidenceWorkspace(t),
      before = f.snapshot();
    const execute = async () => {
      const child = spawn(process.execPath, [entry, ...f.review], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += String(bytes);
      });
      child.stderr.on("data", (bytes) => {
        stderr += String(bytes);
      });
      const closed = once(child, "close"),
        timer = setTimeout(() => child.kill("SIGKILL"), 8000);
      t.after(() => {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      assert.deepEqual(await closed, [0, null], stderr);
      clearTimeout(timer);
      return JSON.parse(stdout);
    };
    const [first, second] = await Promise.all([execute(), execute()]);
    assert.equal(first.evidenceId, second.evidenceId);
    assert.deepEqual(first.stats, second.stats);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(
      readdirSync(f.directory).some((name) => /\.lock$|\.tmp$/.test(name)),
      false,
    );
  },
);

test(
  "real trust/manifest/artifact FIFOs are rejected nonblockingly at the finite entry",
  { timeout: 10_000 },
  (t) => {
    const f = alertEvidenceWorkspace(t);
    for (const file of [f.trust, f.before, join(f.directory, "one.json")]) {
      const bytes = readFileSync(file);
      rmSync(file);
      execFileSync("mkfifo", ["-m", "600", file]);
      const started = performance.now();
      assert.equal(run(f.review, 3).code, "file_io");
      assert.ok(performance.now() - started < 3000);
      rmSync(file);
      writeFileSync(file, bytes, { mode: 0o600 });
    }
  },
);

test(
  "a genuinely full stdout pipe exits boundedly without changing historical evidence",
  { timeout: 12_000 },
  async (t) => {
    const f = alertEvidenceWorkspace(t),
      fifo = join(f.directory, "full-stdout");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    t.after(() => closeSync(reader));
    let filled = false;
    for (let index = 0; index < 1024; index++) {
      try {
        writeSync(writer, Buffer.alloc(4096, 32));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        filled = true;
        break;
      }
    }
    assert.equal(filled, true);
    const originals = f.artifacts.map((item) =>
      readFileSync(join(f.directory, item.file)),
    );
    const started = performance.now();
    const child = spawn(process.execPath, [entry, ...f.review], {
      env: environment,
      stdio: ["ignore", writer, "pipe"],
    });
    closeSync(writer);
    let stderr = "";
    child.stderr!.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const closed = once(child, "close"),
      timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    t.after(async () => {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    });
    assert.deepEqual(await closed, [3, null], stderr);
    clearTimeout(timer);
    assert.equal(JSON.parse(stderr).code, "output_failed");
    assert.ok(performance.now() - started < 6500);
    assert.deepEqual(
      f.artifacts.map((item) => readFileSync(join(f.directory, item.file))),
      originals,
    );
  },
);
