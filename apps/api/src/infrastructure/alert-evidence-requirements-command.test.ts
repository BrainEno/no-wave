import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runAlertEvidenceCommand } from "./alert-evidence-command.ts";
import {
  loadAlertEvidenceFiles,
  readStableEvidenceFile,
} from "./alert-evidence-file.ts";
import { parseAlertEvidenceTrust } from "./alert-evidence-config.ts";
import { handoffHash } from "../application/alert-handoff-protocol.ts";
import { alertEvidenceWorkspace } from "./test-support/alert-evidence-workspace.ts";

function fixture(t: TestContext) {
  const f = alertEvidenceWorkspace(t),
    trust = parseAlertEvidenceTrust(f.publicTrustDocument);
  const requirements = join(f.directory, "requirements.json");
  const document = {
    version: 1,
    role: "evidence-requirements",
    trustFingerprint: trust.fingerprint,
    checkpoints: [
      {
        streamId: f.first.streamId,
        sequence: 2,
        batchId: f.second.id,
        receiptId: handoffHash(
          JSON.parse(
            readFileSync(join(f.directory, "two-receipt.json"), "utf8"),
          ),
        ),
        coverage: "prefix",
      },
    ],
  };
  f.put("requirements.json", document);
  return {
    ...f,
    requirements,
    document,
    args: [
      "check",
      "--trust",
      f.trust,
      "--manifest",
      f.after,
      "--requirements",
      requirements,
    ],
  };
}
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
    /private-requirements-canary|signingKey|senderKey|receiverKey|\.env/,
  );
  return { exit, stdout, stderr };
}

test("check requires an explicit requirements file and verifies it under the same unchanged public trust", async (t) => {
  const f = fixture(t),
    before = f.snapshot();
  const result = await command(f.args);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.requirementsSatisfied, true);
  assert.equal(report.snapshot, "non_atomic_file_evidence");
  assert.equal(report.tailFinality, "not_proven");
  assert.deepEqual(f.snapshot(), before);
  const missing = await command(f.args.slice(0, -2));
  assert.equal(missing.exit, 2);
});

test("a missing known checkpoint yields attention; invalid or secret-bearing requirements are rejected without a partial report", async (t) => {
  const f = fixture(t);
  const args = f.args.map((arg) => (arg === f.after ? f.before : arg));
  const absent = await command(args);
  assert.equal(absent.exit, 1);
  assert.equal(JSON.parse(absent.stdout).requirementsSatisfied, false);
  f.put("requirements.json", {
    ...f.document,
    signingKey: "private-requirements-canary",
  });
  const invalid = await command(f.args);
  assert.equal(invalid.exit, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(JSON.parse(invalid.stderr).code, "requirements_invalid");
});

test("requirements cannot be selected by a manifest or alias another control file", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      loadAlertEvidenceFiles(f.trust, [f.after], { requirementsPath: f.trust }),
    { code: "arguments_invalid" },
  );
  const bytes = readFileSync(f.requirements);
  f.put("after.json", {
    version: 1,
    artifacts: [
      {
        kind: "batch",
        file: "requirements.json",
        sha256: f.hash("requirements.json"),
      },
    ],
  });
  assert.throws(
    () =>
      loadAlertEvidenceFiles(f.trust, [f.after], {
        requirementsPath: f.requirements,
      }),
    { code: "manifest_invalid" },
  );
  assert.deepEqual(readFileSync(f.requirements), bytes);
});

test("requirements rewrites during collection are rejected as unstable evidence, even if JSON semantics are unchanged", (t) => {
  const f = fixture(t);
  let changed = false;
  assert.throws(
    () =>
      loadAlertEvidenceFiles(f.trust, [f.after], {
        requirementsPath: f.requirements,
        read: (path, maximum) => {
          const bytes = readStableEvidenceFile(path, maximum);
          if (!changed && path.endsWith("two.json")) {
            changed = true;
            writeFileSync(
              f.requirements,
              Buffer.concat([readFileSync(f.requirements), Buffer.from(" ")]),
            );
          }
          return bytes;
        },
      }),
    { code: "snapshot_changed" },
  );
});
