import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
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
import test, { type TestContext } from "node:test";
import { handoffFixture } from "./test-support/alert-handoff-fixture.ts";
import { openMonitorJournal } from "./monitor-state-file.ts";

const entry = fileURLToPath(
  new URL("./alert-handoff-command.ts", import.meta.url),
);
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_NO_WARNINGS: "1",
  DATABASE_PROVIDER: "must-not-open",
  DATABASE_URL: "private-handoff-dsn-canary",
  AUTH_JWT_SECRET: "private-handoff-auth-canary",
};
function run(args: string[], expected: number) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected, result.stderr);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private-handoff-|signingKey|receiverKey|metricsUrl|127\.0\.0\.1|PRIVATE KEY/,
  );
  return {
    ...result,
    value: JSON.parse(result.stdout || result.stderr) as Record<
      string,
      unknown
    >,
  };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "nw-handoff-process-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = handoffFixture(),
    senderConfig = join(directory, "sender.json"),
    receiverConfig = join(directory, "receiver.json");
  const senderState = join(directory, "sender-state.json"),
    inboxState = join(directory, "inbox-state.json"),
    monitorConfig = join(directory, "monitor.json"),
    monitorState = join(directory, "alerts.json");
  const batch = join(directory, "outbound.json"),
    receipt = join(directory, "return.json");
  const put = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  put(senderConfig, f.senderDocument);
  put(receiverConfig, f.inboxDocument);
  put(monitorConfig, {
    version: 1,
    targets: f.monitorConfig.targets,
    rules: { target_unavailable: { forMs: 0, resolveMs: 0, repeatMs: 30_000 } },
  });
  const monitor = f.observe(null, Date.now() - 5000);
  put(monitorState, monitor);
  const source = [
    "--config",
    senderConfig,
    "--state",
    senderState,
    "--monitor-config",
    monitorConfig,
    "--monitor-state",
    monitorState,
  ];
  const receiver = ["--config", receiverConfig, "--state", inboxState];
  return {
    ...f,
    directory,
    senderConfig,
    receiverConfig,
    senderState,
    inboxState,
    monitorConfigPath: monitorConfig,
    monitorState,
    batch,
    receipt,
    put,
    source,
    receiver,
    monitor,
  };
}
function concurrent(args: string[]) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += String(data);
  });
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  return once(child, "close")
    .then(([code, signal]) => ({ code, signal, stdout, stderr }))
    .finally(() => clearTimeout(timer));
}

test(
  "independent finite processes transfer copied artifacts, preserve live incidents and consume only on explicit command",
  { timeout: 20_000 },
  (t) => {
    const f = fixture(t),
      before = readFileSync(f.monitorState, "utf8");
    const sent = run(["prepare", ...f.source, "--output", f.batch], 0);
    assert.equal(sent.value.count, 1);
    assert.equal(readFileSync(f.monitorState, "utf8"), before);
    const inbound = join(f.directory, "copied-batch.json"),
      returned = join(f.directory, "copied-receipt.json");
    copyFileSync(f.batch, inbound);
    run(
      ["receive", ...f.receiver, "--batch", inbound, "--output", f.receipt],
      0,
    );
    copyFileSync(f.receipt, returned);
    assert.equal(readFileSync(f.monitorState, "utf8"), before);
    run(["settle", ...f.source, "--receipt", returned], 0);
    const monitor = JSON.parse(readFileSync(f.monitorState, "utf8"));
    assert.equal(monitor.events.length, 0);
    assert.equal(monitor.targets[0].rules[0].phase, "firing");
    const inbox = run(["inbox-read", ...f.receiver, "--limit", "1"], 0);
    assert.equal((inbox.value.entries as unknown[]).length, 1);
    run(
      ["consume", ...f.receiver, "--through", inbox.value.through as string],
      0,
    );
    run(
      [
        "reconcile",
        ...f.source,
        "--inbox-config",
        f.receiverConfig,
        "--inbox-state",
        f.inboxState,
      ],
      0,
    );
    assert.deepEqual(
      readdirSync(f.directory).filter((name) => /\.lock$|\.tmp$/.test(name)),
      [],
    );
  },
);

test(
  "two actual prepare/receive processes cannot fork intent or duplicate an inbox entry",
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    const prepared = await Promise.all(
      [1, 2].map(() =>
        concurrent(["prepare", ...f.source, "--output", f.batch]),
      ),
    );
    assert.ok(prepared.some((result) => result.code === 0));
    for (const result of prepared) {
      assert.equal(result.signal, null);
      assert.ok(result.code === 0 || result.code === 3, result.stderr);
      if (result.code === 3)
        assert.match(result.stderr, /state_locked|state_io/);
    }
    const ledger = JSON.parse(readFileSync(f.senderState, "utf8"));
    assert.equal(ledger.revision, 1);
    assert.equal(
      ledger.pending.batch.id,
      JSON.parse(readFileSync(f.batch, "utf8")).id,
    );
    const received = await Promise.all(
      [1, 2].map(() =>
        concurrent([
          "receive",
          ...f.receiver,
          "--batch",
          f.batch,
          "--output",
          f.receipt,
        ]),
      ),
    );
    assert.ok(received.some((result) => result.code === 0));
    for (const result of received) {
      assert.equal(result.signal, null);
      assert.ok(result.code === 0 || result.code === 3, result.stderr);
      if (result.code === 3)
        assert.match(result.stderr, /state_locked|state_io/);
    }
    const inbox = JSON.parse(readFileSync(f.inboxState, "utf8"));
    assert.equal(inbox.entries.length, 1);
    assert.equal(inbox.revision, 1);
    assert.equal(
      run(
        ["receive", ...f.receiver, "--batch", f.batch, "--output", f.receipt],
        0,
      ).value.duplicate,
      true,
    );
  },
);

test(
  "a real monitor lock interrupts settlement after durable receipt intent; retry finishes without duplicate acknowledgement",
  { timeout: 15_000 },
  (t) => {
    const f = fixture(t);
    run(["prepare", ...f.source, "--output", f.batch], 0);
    run(
      ["receive", ...f.receiver, "--batch", f.batch, "--output", f.receipt],
      0,
    );
    const held = openMonitorJournal(f.monitorState, f.monitorConfig);
    try {
      assert.equal(
        run(["settle", ...f.source, "--receipt", f.receipt], 3).value.code,
        "state_locked",
      );
      const durable = JSON.parse(readFileSync(f.senderState, "utf8"));
      assert.equal(durable.revision, 2);
      assert.ok(durable.pending.receipt);
      assert.equal(existsSync(f.senderState + ".lock"), false);
      assert.equal(
        run(["sender-status", ...f.source], 1).value.phase,
        "awaiting_ack",
      );
    } finally {
      held.close();
    }
    assert.equal(
      run(["settle", ...f.source, "--receipt", f.receipt], 0).value
        .acknowledged,
      1,
    );
    assert.equal(
      run(["settle", ...f.source, "--receipt", f.receipt], 0).value
        .acknowledged,
      0,
    );
  },
);

test(
  "config, state, batch and output FIFOs fail finitely without opening a business store or stealing locks",
  { timeout: 20_000 },
  (t) => {
    const f = fixture(t),
      fifo = join(f.directory, "not-a-file");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    run(["prepare", ...f.source, "--output", f.batch], 0);
    const original = readFileSync(f.monitorState, "utf8");
    assert.equal(
      run(
        [
          "receive",
          "--config",
          fifo,
          "--state",
          f.inboxState,
          "--batch",
          f.batch,
          "--output",
          f.receipt,
        ],
        2,
      ).value.code,
      "config_invalid",
    );
    assert.equal(
      run(["receive", ...f.receiver, "--batch", fifo, "--output", f.receipt], 3)
        .value.code,
      "artifact_invalid",
    );
    assert.equal(
      run(
        [
          "receive",
          "--config",
          f.receiverConfig,
          "--state",
          fifo,
          "--batch",
          f.batch,
          "--output",
          f.receipt,
        ],
        3,
      ).value.code,
      "state_io",
    );
    assert.equal(
      run(["receive", ...f.receiver, "--batch", f.batch, "--output", fifo], 3)
        .value.code,
      "state_io",
    );
    assert.equal(
      JSON.parse(readFileSync(f.inboxState, "utf8")).entries.length,
      1,
    );
    assert.equal(readFileSync(f.monitorState, "utf8"), original);
    assert.equal(existsSync(f.inboxState + ".lock"), false);
    assert.equal(existsSync(fifo + ".lock"), false);
  },
);

test(
  "a genuinely full stdout pipe cannot keep prepare/receive alive or erase committed intent and receipts",
  { timeout: 18_000 },
  async (t) => {
    const f = fixture(t),
      original = readFileSync(f.monitorState, "utf8");
    for (const [index, args] of [
      ["prepare", ["prepare", ...f.source, "--output", f.batch]],
      [
        "receive",
        ["receive", ...f.receiver, "--batch", f.batch, "--output", f.receipt],
      ],
    ] as const) {
      const fifo = join(f.directory, "full-stdout-" + index);
      execFileSync("mkfifo", ["-m", "600", fifo]);
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK),
        writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      t.after(() => closeSync(reader));
      let filled = false;
      for (let i = 0; i < 1024; i++) {
        try {
          writeSync(writer, Buffer.alloc(4096, 32));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
          filled = true;
          break;
        }
      }
      assert.equal(filled, true);
      const started = performance.now(),
        child = spawn(process.execPath, [entry, ...args], {
          env: environment,
          stdio: ["ignore", writer, "pipe"],
        });
      closeSync(writer);
      let stderr = "";
      child.stderr!.on("data", (data) => {
        stderr += String(data);
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
      assert.ok(performance.now() - started < 6500);
      assert.equal(JSON.parse(stderr).code, "output_failed");
      assert.equal(readFileSync(f.monitorState, "utf8"), original);
      assert.equal(existsSync(f.senderState + ".lock"), false);
      assert.equal(existsSync(f.inboxState + ".lock"), false);
    }
    assert.ok(JSON.parse(readFileSync(f.senderState, "utf8")).pending);
    assert.equal(
      JSON.parse(readFileSync(f.inboxState, "utf8")).entries.length,
      1,
    );
    assert.equal(
      run(
        ["receive", ...f.receiver, "--batch", f.batch, "--output", f.receipt],
        0,
      ).value.duplicate,
      true,
    );
  },
);
