import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { handoffFixture } from "./test-support/alert-handoff-fixture.ts";
import { runAlertHandoffCommand } from "./alert-handoff-command.ts";
import { openMonitorJournal } from "./monitor-state-file.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "no-wave-handoff-cli-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = handoffFixture(),
    senderConfig = join(directory, "sender.json"),
    inboxConfig = join(directory, "receiver.json");
  const senderState = join(directory, "sender-state.json"),
    inboxState = join(directory, "inbox-state.json");
  const monitorConfig = join(directory, "monitor.json"),
    monitorState = join(directory, "monitor-state.json");
  const batch = join(directory, "batch.json"),
    receipt = join(directory, "receipt.json");
  const put = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value) + "\n", { mode: 0o600 });
  put(senderConfig, f.senderDocument);
  put(inboxConfig, f.inboxDocument);
  put(monitorConfig, {
    version: 1,
    targets: f.monitorConfig.targets,
    rules: { target_unavailable: { forMs: 0, resolveMs: 0, repeatMs: 30_000 } },
  });
  const journal = openMonitorJournal(monitorState, f.monitorConfig);
  journal.commit(f.monitor);
  journal.close();
  const out: string[] = [],
    err: string[] = [];
  const deps = {
    stdout: (s: string) => {
      out.push(s);
    },
    stderr: (s: string) => {
      err.push(s);
    },
    now: () => f.now + 1,
  };
  const sender = [
    "--config",
    senderConfig,
    "--state",
    senderState,
    "--monitor-config",
    monitorConfig,
    "--monitor-state",
    monitorState,
  ];
  const inbox = ["--config", inboxConfig, "--state", inboxState];
  return {
    ...f,
    directory,
    senderConfig,
    inboxConfig,
    senderState,
    inboxState,
    monitorConfigPath: monitorConfig,
    monitorState,
    batch,
    receipt,
    put,
    out,
    err,
    deps,
    sender,
    inbox,
  };
}

test("finite CLI performs prepare -> receive -> explicit settle -> explicit consume; every read is offline", async (t) => {
  const f = fixture(t),
    original = readFileSync(f.monitorState, "utf8");
  assert.equal(
    await runAlertHandoffCommand(
      ["prepare", ...f.sender, "--output", f.batch],
      f.deps,
    ),
    0,
  );
  const prepared = readFileSync(f.senderState, "utf8"),
    batch = readFileSync(f.batch, "utf8");
  assert.equal(readFileSync(f.monitorState, "utf8"), original);
  assert.equal(
    await runAlertHandoffCommand(
      ["prepare", ...f.sender, "--output", f.batch],
      f.deps,
    ),
    0,
  );
  assert.equal(readFileSync(f.senderState, "utf8"), prepared);
  assert.equal(readFileSync(f.batch, "utf8"), batch);
  assert.equal(
    await runAlertHandoffCommand(["sender-status", ...f.sender], f.deps),
    1,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).phase, "awaiting_receipt");
  assert.equal(
    await runAlertHandoffCommand(
      ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
      f.deps,
    ),
    0,
  );
  const inboxBefore = readFileSync(f.inboxState, "utf8"),
    receipt = readFileSync(f.receipt, "utf8");
  assert.equal(
    await runAlertHandoffCommand(
      ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
      f.deps,
    ),
    0,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).duplicate, true);
  assert.equal(readFileSync(f.receipt, "utf8"), receipt);
  assert.equal(readFileSync(f.inboxState, "utf8"), inboxBefore);
  assert.equal(readFileSync(f.monitorState, "utf8"), original);
  assert.equal(
    await runAlertHandoffCommand(
      ["settle", ...f.sender, "--receipt", f.receipt],
      f.deps,
    ),
    0,
  );
  assert.equal(
    JSON.parse(readFileSync(f.monitorState, "utf8")).events.length,
    0,
  );
  assert.equal(
    JSON.parse(readFileSync(f.monitorState, "utf8")).targets[0].rules[0].phase,
    "firing",
  );
  const settled = readFileSync(f.senderState, "utf8"),
    monitorAfter = readFileSync(f.monitorState, "utf8");
  assert.equal(
    await runAlertHandoffCommand(
      ["settle", ...f.sender, "--receipt", f.receipt],
      f.deps,
    ),
    0,
  );
  assert.equal(readFileSync(f.senderState, "utf8"), settled);
  assert.equal(readFileSync(f.monitorState, "utf8"), monitorAfter);
  assert.equal(
    await runAlertHandoffCommand(
      ["inbox-read", ...f.inbox, "--limit", "1"],
      f.deps,
    ),
    0,
  );
  const entry = JSON.parse(f.out.at(-1)!).entries[0];
  assert.equal(entry.event.id, f.monitor.events[0].id);
  assert.equal(
    await runAlertHandoffCommand(
      ["consume", ...f.inbox, "--through", entry.id],
      f.deps,
    ),
    0,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).consumed, 1);
  assert.equal(
    await runAlertHandoffCommand(["inbox-status", ...f.inbox], f.deps),
    0,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).pending, 0);
  assert.equal(
    await runAlertHandoffCommand(["sender-status", ...f.sender], f.deps),
    0,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).phase, "idle");
  assert.doesNotMatch(
    f.out.join("") + f.err.join(""),
    /signingKey|receiverKey|metricsUrl|127\.0\.0\.1|PRIVATE KEY/,
  );
  assert.deepEqual(
    readdirSync(f.directory).filter(
      (name) => name.endsWith(".lock") || name.endsWith(".tmp"),
    ),
    [],
  );
});

test("invalid arguments and path/lock collisions are rejected before changing any file", async (t) => {
  const f = fixture(t),
    original = readFileSync(f.monitorState, "utf8");
  const bad = [
    [],
    ["watch"],
    ["prepare", ...f.sender],
    ["prepare", ...f.sender, "--output", f.senderState],
    ["prepare", ...f.sender, "--output", f.monitorState + ".lock"],
    [
      "prepare",
      ...f.sender,
      "--output",
      f.batch,
      "--token",
      "credential-canary",
    ],
    ["inbox-read", ...f.inbox, "--limit", "0"],
    ["inbox-read", ...f.inbox, "--limit", "257"],
    ["inbox-status", ...f.inbox, "--through", "a".repeat(64)],
    ["settle", ...f.sender, "--receipt", f.senderConfig],
  ];
  for (const args of bad)
    assert.equal(await runAlertHandoffCommand(args, f.deps), 2, args[0]);
  assert.equal(existsSync(f.senderState), false);
  assert.equal(existsSync(f.inboxState), false);
  assert.equal(readFileSync(f.monitorState, "utf8"), original);
  assert.doesNotMatch(f.err.join(""), /credential-canary|sender\.json/);
});

test("artifact publication failures preserve pending intent and durable inbox receipts for later retry", async (t) => {
  const f = fixture(t);
  f.put(f.batch, { unrelated: true });
  assert.equal(
    await runAlertHandoffCommand(
      ["prepare", ...f.sender, "--output", f.batch],
      f.deps,
    ),
    3,
  );
  assert.match(f.err.at(-1)!, /artifact_conflict/);
  assert.ok(JSON.parse(readFileSync(f.senderState, "utf8")).pending);
  assert.deepEqual(JSON.parse(readFileSync(f.batch, "utf8")), {
    unrelated: true,
  });
  rmSync(f.batch);
  assert.equal(
    await runAlertHandoffCommand(
      ["prepare", ...f.sender, "--output", f.batch],
      f.deps,
    ),
    0,
  );
  f.put(f.receipt, { unrelated: true });
  assert.equal(
    await runAlertHandoffCommand(
      ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
      f.deps,
    ),
    3,
  );
  const durable = readFileSync(f.inboxState, "utf8");
  assert.equal(JSON.parse(durable).entries.length, 1);
  rmSync(f.receipt);
  assert.equal(
    await runAlertHandoffCommand(
      ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
      f.deps,
    ),
    0,
  );
  assert.equal(readFileSync(f.inboxState, "utf8"), durable);
  assert.equal(JSON.parse(f.out.at(-1)!).duplicate, true);
});

test("missing state, wrong peer, output failure and cancellation never imply acknowledgement or healthy status", async (t) => {
  const f = fixture(t),
    original = readFileSync(f.monitorState, "utf8");
  assert.equal(
    await runAlertHandoffCommand(["sender-status", ...f.sender], f.deps),
    3,
  );
  assert.equal(
    await runAlertHandoffCommand(["inbox-status", ...f.inbox], f.deps),
    3,
  );
  assert.equal(
    await runAlertHandoffCommand(
      ["prepare", ...f.sender, "--output", f.batch],
      { ...f.deps, signal: AbortSignal.abort() },
    ),
    3,
  );
  assert.equal(existsSync(f.senderState), false);
  assert.equal(
    await runAlertHandoffCommand(
      ["prepare", ...f.sender, "--output", f.batch],
      {
        ...f.deps,
        stdout() {
          throw new Error("private-canary");
        },
      },
    ),
    3,
  );
  assert.match(f.err.at(-1)!, /output_failed/);
  assert.equal(existsSync(f.batch), true);
  const foreign = handoffFixture();
  f.put(f.inboxConfig, foreign.inboxDocument);
  assert.equal(
    await runAlertHandoffCommand(
      ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
      f.deps,
    ),
    3,
  );
  assert.equal(existsSync(f.inboxState), false);
  assert.equal(existsSync(f.receipt), false);
  assert.equal(readFileSync(f.monitorState, "utf8"), original);
  assert.doesNotMatch(f.err.join(""), /private-canary|Error:|stack/);
});

test("receipt recovery, bounded paging, pending-age status and reconciliation stay read-only under existing locks", async (t) => {
  const f = fixture(t);
  await runAlertHandoffCommand(
    ["prepare", ...f.sender, "--output", f.batch],
    f.deps,
  );
  await runAlertHandoffCommand(
    ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
    f.deps,
  );
  const inboxBefore = readFileSync(f.inboxState, "utf8"),
    senderBefore = readFileSync(f.senderState, "utf8");
  const reconcile = [
    "reconcile",
    ...f.sender,
    "--inbox-config",
    f.inboxConfig,
    "--inbox-state",
    f.inboxState,
  ];
  const recovered = join(f.directory, "recovered.json");
  const batch = JSON.parse(readFileSync(f.batch, "utf8"));
  f.put(f.inboxState + ".lock", { foreign: "do-not-steal" });
  f.put(f.senderState + ".lock", { foreign: "do-not-steal" });
  f.put(f.monitorState + ".lock", { foreign: "do-not-steal" });
  assert.equal(await runAlertHandoffCommand(reconcile, f.deps), 1);
  assert.equal(JSON.parse(f.out.at(-1)!).stage, "received_awaiting_settlement");
  assert.equal(
    await runAlertHandoffCommand(
      [
        "receipt",
        ...f.inbox,
        "--stream",
        f.senderDocument.streamId,
        "--sequence",
        "1",
        "--batch-id",
        batch.id,
        "--output",
        recovered,
      ],
      f.deps,
    ),
    0,
  );
  assert.equal(
    readFileSync(recovered, "utf8"),
    readFileSync(f.receipt, "utf8"),
  );
  assert.equal(
    await runAlertHandoffCommand(
      ["inbox-status", ...f.inbox, "--max-pending-age-ms", "1000"],
      { ...f.deps, now: () => f.now + 2001 },
    ),
    1,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).age, "overdue");
  assert.equal(
    await runAlertHandoffCommand(
      ["inbox-read", ...f.inbox, "--after", "malformed"],
      f.deps,
    ),
    3,
  );
  assert.match(f.err.at(-1)!, /cursor_invalid/);
  assert.equal(readFileSync(f.inboxState, "utf8"), inboxBefore);
  assert.equal(readFileSync(f.senderState, "utf8"), senderBefore);
  for (const path of [f.inboxState, f.senderState, f.monitorState])
    assert.equal(
      JSON.parse(readFileSync(path + ".lock", "utf8")).foreign,
      "do-not-steal",
    );
});

test("profile exports only public pins and verify requires neither mutable journal nor signing keys", async (t) => {
  const f = fixture(t),
    profile = join(f.directory, "public-profile.json");
  const original = readFileSync(f.monitorState, "utf8");
  assert.equal(
    await runAlertHandoffCommand(
      ["profile", "--config", f.senderConfig, "--output", profile],
      f.deps,
    ),
    0,
  );
  const document = JSON.parse(readFileSync(profile, "utf8"));
  assert.equal(document.role, "verify");
  assert.equal(document.signingKey, undefined);
  await runAlertHandoffCommand(
    ["prepare", ...f.sender, "--output", f.batch],
    f.deps,
  );
  await runAlertHandoffCommand(
    ["receive", ...f.inbox, "--batch", f.batch, "--output", f.receipt],
    f.deps,
  );
  const senderBefore = readFileSync(f.senderState, "utf8"),
    inboxBefore = readFileSync(f.inboxState, "utf8");
  rmSync(f.senderConfig);
  rmSync(f.inboxConfig);
  assert.equal(
    await runAlertHandoffCommand(
      [
        "verify",
        "--config",
        profile,
        "--batch",
        f.batch,
        "--receipt",
        f.receipt,
      ],
      f.deps,
    ),
    0,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).receiptProof, "durable_acceptance");
  assert.equal(
    await runAlertHandoffCommand(
      ["verify", "--config", profile, "--batch", f.batch],
      f.deps,
    ),
    0,
  );
  assert.equal(JSON.parse(f.out.at(-1)!).receiptProof, "not_provided");
  assert.equal(readFileSync(f.monitorState, "utf8"), original);
  assert.equal(readFileSync(f.senderState, "utf8"), senderBefore);
  assert.equal(readFileSync(f.inboxState, "utf8"), inboxBefore);
});
