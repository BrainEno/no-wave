import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runAlertEvidenceCommand } from "./alert-evidence-command.ts";
import { alertEvidenceWorkspace } from "./test-support/alert-evidence-workspace.ts";

async function command(
  args: string[],
  dependencies: Parameters<typeof runAlertEvidenceCommand>[1] = {},
) {
  let stdout = "",
    stderr = "";
  const exit = await runAlertEvidenceCommand(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...dependencies,
  });
  assert.doesNotMatch(
    stdout + stderr,
    /env-file-canary|signingKey|privateKey|senderKey|receiverKey|metricsUrl|private-exception-canary/,
  );
  return { exit, stdout, stderr };
}

test("review/compare are finite public-only commands and leave even locked operational inputs unchanged", async (t) => {
  const f = alertEvidenceWorkspace(t),
    before = f.snapshot();
  const reviewed = await command(f.review);
  assert.equal(reviewed.exit, 0);
  assert.equal(reviewed.stderr, "");
  const report = JSON.parse(reviewed.stdout);
  assert.equal(report.stats.batches, 1);
  assert.equal(report.snapshot, "non_atomic_file_evidence");
  assert.equal(report.tailFinality, "not_proven");
  const compared = await command(f.compare);
  assert.equal(compared.exit, 0);
  assert.equal(compared.stderr, "");
  assert.equal(JSON.parse(compared.stdout).change, "extended");
  assert.deepEqual(f.snapshot(), before);
  const help = await command(["--help"]);
  assert.equal(help.exit, 0);
  assert.match(help.stdout, /不联网/);
  assert.match(help.stdout, /不会确认|不确认/);
});

test("gaps yield attention while malformed trust/manifest/material fail closed with no partial report or secret dump", async (t) => {
  const f = alertEvidenceWorkspace(t);
  f.put("before.json", { version: 1, artifacts: [f.artifacts[0]] });
  const missing = await command(f.review);
  assert.equal(missing.exit, 1);
  assert.ok(
    JSON.parse(missing.stdout).findings.some(
      (item: { code: string }) => item.code === "receipt_missing",
    ),
  );
  f.put("one.json", { ...f.first, preparedAt: f.first.preparedAt + 1 });
  const integrity = await command(f.review);
  assert.equal(integrity.exit, 3);
  assert.equal(integrity.stdout, "");
  assert.equal(JSON.parse(integrity.stderr).code, "integrity_mismatch");
  f.put("before.json", {
    version: 1,
    artifacts: [{ ...f.artifacts[0], sha256: f.hash("one.json") }],
  });
  const signature = await command(f.review);
  assert.equal(signature.exit, 3);
  assert.equal(signature.stdout, "");
  assert.equal(JSON.parse(signature.stderr).code, "artifact_invalid");
  f.put("trust.json", {
    ...f.publicTrustDocument,
    signingKey: "private-exception-canary",
  });
  const trust = await command(f.review);
  assert.equal(trust.exit, 2);
  assert.equal(trust.stdout, "");
  assert.equal(JSON.parse(trust.stderr).code, "trust_invalid");
  assert.equal(JSON.parse(trust.stderr).event, "alert_evidence_error");
});

test("strict flags, canonical bounded budgets and pre-aborted commands do not load or modify evidence", async (t) => {
  const f = alertEvidenceWorkspace(t),
    before = f.snapshot();
  for (const args of [
    [],
    ["verify"],
    ["--help", "--trust", f.trust],
    ["review"],
    [...f.review, "--trust", f.trust],
    [...f.review, "--output", "private-exception-canary"],
    [...f.review, "--max-age-ms", "0001000"],
    [...f.review, "--max-age-ms", "1e6"],
    [...f.review, "--max-age-ms", "999"],
    [...f.review, "--max-age-ms", "2592000001"],
    [...f.review, "--max-age-ms", "Infinity"],
    [...f.review, "--max-age-ms"],
    [
      "review",
      "--trust",
      "a\nprivate-exception-canary",
      "--manifest",
      f.before,
    ],
  ]) {
    const result = await command(args);
    assert.equal(result.exit, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).code, "arguments_invalid");
  }
  const controller = new AbortController();
  controller.abort();
  const stopped = await command(f.review, { signal: controller.signal });
  assert.equal(stopped.exit, 3);
  assert.equal(JSON.parse(stopped.stderr).code, "cancelled");
  assert.deepEqual(f.snapshot(), before);
});

test("an explicit evidence age budget is a review warning, never a refreshed service observation", async (t) => {
  const f = alertEvidenceWorkspace(t);
  const result = await command([...f.review, "--max-age-ms", "1000"]);
  assert.equal(result.exit, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(
    report.findings.some(
      (item: { code: string }) => item.code === "evidence_stale",
    ),
  );
  assert.equal(report.streams[0].oldestEventAt, f.first.events[0]!.at);
  assert.ok(report.streams[0].oldestEventAgeMs >= 60_000);
});

test("output failures preserve every input and never fall back to raw exceptions, paths or payloads", async (t) => {
  const f = alertEvidenceWorkspace(t),
    before = f.snapshot();
  const failed = await command(f.review, {
    stdout: () => {
      throw new Error("private-exception-canary");
    },
  });
  assert.equal(failed.exit, 3);
  assert.equal(JSON.parse(failed.stderr).code, "output_failed");
  const silent = await command(f.review, {
    stdout: () => {
      throw new Error("private-exception-canary");
    },
    stderr: () => {
      throw new Error("private-exception-canary");
    },
  });
  assert.equal(silent.exit, 3);
  assert.equal(silent.stdout + silent.stderr, "");
  assert.deepEqual(f.snapshot(), before);
  assert.match(readFileSync(join(f.directory, ".env"), "utf8"), /canary/);
});
