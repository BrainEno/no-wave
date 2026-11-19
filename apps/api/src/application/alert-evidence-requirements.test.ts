import assert from "node:assert/strict";
import test from "node:test";
import {
  alertEvidenceFixture,
  evidenceInputs,
} from "../infrastructure/test-support/alert-evidence-fixture.ts";
import { parseAlertEvidenceTrust } from "../infrastructure/alert-evidence-config.ts";
import {
  checkAlertEvidenceRequirements,
  parseEvidenceRequirements,
} from "./alert-evidence-requirements.ts";
import { handoffHash } from "./alert-handoff-protocol.ts";

function fixture() {
  const f = alertEvidenceFixture();
  const trust = parseAlertEvidenceTrust({
    ...f.trustDocument,
    profiles: [f.trustDocument.profiles[0]],
  });
  const one = f.batch(0, 1, null),
    two = f.batch(0, 2, one);
  const r1 = f.receipt(one),
    r2 = f.receipt(two);
  const checkpoint = {
    streamId: one.streamId,
    sequence: 2,
    batchId: two.id,
    receiptId: handoffHash(r2),
    coverage: "prefix",
  };
  const document = {
    version: 1,
    role: "evidence-requirements",
    trustFingerprint: trust.fingerprint,
    checkpoints: [checkpoint],
  };
  return {
    ...f,
    trust,
    one,
    two,
    r1,
    r2,
    checkpoint,
    document,
    options: { now: f.reportedAt },
  };
}

test("explicit independently supplied checkpoints prove only a retained point or prefix, never an unseen tail", () => {
  const f = fixture(),
    inputs = evidenceInputs([f.one, f.two], [f.r1, f.r2]);
  const result = checkAlertEvidenceRequirements(
    f.trust,
    inputs,
    f.document,
    f.options,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.requirementsSatisfied, true);
  assert.equal(result.checkpoints[0]!.prefix!.batches, 2);
  assert.equal(result.checkpoints[0]!.prefix!.firstBatchId, f.one.id);
  assert.equal(result.checkpoints[0]!.prefix!.lastBatchId, f.two.id);
  assert.equal(result.tailFinality, "not_proven");
  assert.equal(result.report.evidenceId.length, 64);
  assert.deepEqual(
    checkAlertEvidenceRequirements(
      f.trust,
      [...inputs].reverse(),
      f.document,
      f.options,
    ),
    result,
  );
  const point = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.two], [f.r2]),
    {
      ...f.document,
      checkpoints: [{ ...f.checkpoint, coverage: "point" }],
    },
    f.options,
  );
  assert.equal(point.requirementsSatisfied, true);
  assert.equal(
    point.exitCode,
    1,
    "matching a point must not hide the review's missing prefix",
  );
  assert.equal(point.checkpoints[0]!.prefix, null);
});

test("valid signatures on a shorter, replaced or unreceipted set cannot satisfy known evidence requirements", () => {
  const f = fixture();
  const missing = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.one], [f.r1]),
    f.document,
    f.options,
  );
  assert.equal(missing.requirementsSatisfied, false);
  assert.ok(missing.checkpoints[0]!.failures.includes("checkpoint_missing"));
  const prefixGap = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.two], [f.r2]),
    f.document,
    f.options,
  );
  assert.equal(prefixGap.requirementsSatisfied, false);
  assert.ok(prefixGap.checkpoints[0]!.failures.includes("prefix_missing"));
  const receiptGap = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.one, f.two], [f.r1]),
    f.document,
    f.options,
  );
  assert.ok(receiptGap.checkpoints[0]!.failures.includes("receipt_missing"));
  const wrongReceipt = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.one, f.two], [f.r1, f.r2]),
    {
      ...f.document,
      checkpoints: [{ ...f.checkpoint, receiptId: handoffHash(f.r1) }],
    },
    f.options,
  );
  assert.ok(wrongReceipt.checkpoints[0]!.failures.includes("receipt_mismatch"));
});

test("a fork cannot be selected away by an exact checkpoint, and mismatched predecessor identity is not a complete prefix", () => {
  const f = fixture(),
    fork = f.batch(0, 2, f.one, { preparedAt: f.two.preparedAt + 1 });
  const ambiguous = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.one, f.two, fork], [f.r1, f.r2]),
    f.document,
    f.options,
  );
  assert.equal(ambiguous.requirementsSatisfied, false);
  assert.ok(ambiguous.checkpoints[0]!.failures.includes("checkpoint_forked"));
  const bad = f.batch(0, 2, f.one, { previousId: "a".repeat(64) });
  const requirements = {
    ...f.document,
    checkpoints: [{ ...f.checkpoint, batchId: bad.id, receiptId: null }],
  };
  const broken = checkAlertEvidenceRequirements(
    f.trust,
    evidenceInputs([f.one, bad]),
    requirements,
    f.options,
  );
  assert.ok(broken.checkpoints[0]!.failures.includes("prefix_missing"));
  assert.equal(broken.exitCode, 1);
});

test("checkpoint configuration is closed, trust-bound, canonical and bounded without changing existing v1 profiles", () => {
  const f = fixture();
  const parsed = parseEvidenceRequirements(f.document, f.trust);
  assert.equal(parsed.checkpoints.length, 1);
  for (const value of [
    null,
    { ...f.document, version: 2 },
    { ...f.document, trustFingerprint: "a".repeat(64) },
    { ...f.document, checkpoints: [] },
    { ...f.document, signingKey: "private-requirements-canary" },
    { ...f.document, checkpoints: [f.checkpoint, f.checkpoint] },
    {
      ...f.document,
      checkpoints: [{ ...f.checkpoint, streamId: f.senders[1]!.streamId }],
    },
    { ...f.document, checkpoints: [{ ...f.checkpoint, sequence: 0 }] },
    {
      ...f.document,
      checkpoints: [{ ...f.checkpoint, sequence: Number.MAX_SAFE_INTEGER + 1 }],
    },
    {
      ...f.document,
      checkpoints: [{ ...f.checkpoint, batchId: "A".repeat(64) }],
    },
    {
      ...f.document,
      checkpoints: [{ ...f.checkpoint, receiptId: "not-a-hash" }],
    },
    { ...f.document, checkpoints: [{ ...f.checkpoint, coverage: "force" }] },
  ])
    assert.throws(() => parseEvidenceRequirements(value, f.trust), {
      code: "requirements_invalid",
    });
  assert.throws(
    () =>
      parseEvidenceRequirements(
        {
          ...f.document,
          checkpoints: Array.from({ length: 65 }, (_, i) => ({
            ...f.checkpoint,
            sequence: i + 1,
            batchId: handoffHash(i),
          })),
        },
        f.trust,
      ),
    { code: "budget_exceeded" },
  );
});
