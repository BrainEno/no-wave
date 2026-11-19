import assert from "node:assert/strict";
import test from "node:test";
import { runAlertEvidenceCommand } from "./alert-evidence-command.ts";
import { alertEvidenceWorkspace } from "./test-support/alert-evidence-workspace.ts";

async function command(args: string[]) {
  let stdout = "",
    stderr = "";
  const exit = await runAlertEvidenceCommand(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.doesNotMatch(
    stdout + stderr,
    /signingKey|senderKey|receiverKey|privateKey|canary/,
  );
  return { exit, stdout, stderr };
}

test("trace exposes bounded event navigation and a repeatable continuation without writing files", async (t) => {
  const f = alertEvidenceWorkspace(t),
    original = f.snapshot();
  const args = [
    "trace",
    "--trust",
    f.trust,
    "--manifest",
    f.after,
    "--limit",
    "1",
  ];
  const first = await command(args);
  assert.equal(first.exit, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.entries.length, 1);
  assert.equal(report.matched, 2);
  const second = await command([...args, "--after", report.continuation]);
  assert.equal(second.exit, 0);
  assert.equal(JSON.parse(second.stdout).continuation, null);
  const exact = await command([
    ...args,
    "--batch-id",
    report.entries[0].batchId,
    "--event-id",
    report.entries[0].event.id,
  ]);
  assert.equal(exact.exit, 0);
  assert.equal(JSON.parse(exact.stdout).matched, 1);
  assert.equal(JSON.parse(exact.stdout).continuation, null);
  assert.deepEqual(f.snapshot(), original);
});

test("trace filter arguments are explicit, canonical and cannot suppress authentication or attention status", async (t) => {
  const f = alertEvidenceWorkspace(t);
  f.put("after.json", {
    version: 1,
    artifacts: [f.artifacts[0], f.artifacts[2]],
  });
  const args = ["trace", "--trust", f.trust, "--manifest", f.after];
  const findings = await command([
    ...args,
    "--view",
    "findings",
    "--code",
    "receipt_missing",
    "--severity",
    "gap",
  ]);
  assert.equal(findings.exit, 1, findings.stderr);
  assert.equal(JSON.parse(findings.stdout).entries.length, 2);
  const empty = await command([...args, "--target", "not-present"]);
  assert.equal(empty.exit, 1);
  assert.equal(JSON.parse(empty.stdout).matched, 0);
  for (const extras of [
    ["--limit", "01"],
    ["--from-at", "1e3"],
    ["--from-sequence", "-1"],
    ["--from-at", "9007199254740992"],
    ["--view", "findings", "--target", "worker-one"],
    ["--severity", "conflict"],
    ["--rule", "unknown"],
    ["--batch-id", "A".repeat(64)],
    ["--event-id", "unrecognized"],
  ])
    assert.equal(
      (await command([...args, ...extras])).exit,
      2,
      extras.join(" "),
    );
  const malformed = await command([...args, "--after", "bad=="]);
  assert.equal(malformed.exit, 2);
  assert.equal(JSON.parse(malformed.stderr).code, "cursor_invalid");
});
