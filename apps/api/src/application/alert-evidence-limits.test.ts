import assert from "node:assert/strict";
import test from "node:test";
import {
  createHandoffBatch,
  type HandoffBatch,
} from "./alert-handoff-protocol.ts";
import { reviewAlertEvidence } from "./alert-evidence-review.ts";
import { EVIDENCE_LIMITS } from "./alert-evidence.ts";
import { parseAlertEvidenceTrust } from "../infrastructure/alert-evidence-config.ts";
import {
  alertEvidenceFixture,
  evidenceInputs,
} from "../infrastructure/test-support/alert-evidence-fixture.ts";

function fixture() {
  const f = alertEvidenceFixture();
  const trust = parseAlertEvidenceTrust({
    ...f.trustDocument,
    profiles: [f.trustDocument.profiles[0]],
  });
  return { ...f, trust };
}

test("raw byte admission counts canonical duplicates against the aggregate budget", () => {
  const f = fixture(),
    batch = f.batch(0, 1, null);
  const bytes = Buffer.alloc(EVIDENCE_LIMITS.artifactBytes, 32);
  bytes.write(JSON.stringify(batch));
  const input = { kind: "batch" as const, bytes };
  const maximum = EVIDENCE_LIMITS.totalBytes / bytes.length;
  const accepted = Array.from({ length: maximum }, () => input);
  const report = reviewAlertEvidence(f.trust, accepted, { now: f.reportedAt });
  assert.equal(report.stats.inputBytes, EVIDENCE_LIMITS.totalBytes);
  assert.equal(report.stats.artifacts, 1);
  assert.equal(report.stats.duplicates, maximum - 1);
  assert.throws(
    () =>
      reviewAlertEvidence(f.trust, [...accepted, input], { now: f.reportedAt }),
    { code: "budget_exceeded" },
  );
});

test("unique batch event admission is inclusive at 8192 and rejects the next signed batch", () => {
  const f = fixture(),
    batches: HandoffBatch[] = [];
  for (let sequence = 1; sequence <= 33; sequence++) {
    const events = Array.from({ length: 256 }, (_, index) => {
      const revision = (sequence - 1) * 256 + index + 1;
      return f.event(revision, revision === 1 ? "firing" : "reminder");
    });
    batches.push(
      createHandoffBatch(
        f.senders[0]!,
        events,
        f.monitor.fingerprint,
        sequence,
        batches.at(-1)?.id ?? null,
        events.at(-1)!.at + 10,
      ),
    );
  }
  const options = {
    now: batches.at(-1)!.preparedAt + 1,
    maxAgeMs: EVIDENCE_LIMITS.maximumAgeMs,
  };
  const accepted = evidenceInputs(batches.slice(0, 32));
  assert.equal(
    reviewAlertEvidence(f.trust, accepted, options).stats.events,
    EVIDENCE_LIMITS.events,
  );
  assert.equal(
    reviewAlertEvidence(f.trust, [...accepted, accepted[0]!], options).stats
      .events,
    EVIDENCE_LIMITS.events,
  );
  assert.throws(
    () => reviewAlertEvidence(f.trust, evidenceInputs(batches), options),
    { code: "budget_exceeded" },
  );
});
