import assert from "node:assert/strict";
import { sign } from "node:crypto";
import test from "node:test";
import {
  alertEvidenceFixture,
  evidenceInputs,
} from "../infrastructure/test-support/alert-evidence-fixture.ts";
import { parseAlertEvidenceTrust } from "../infrastructure/alert-evidence-config.ts";
import { reviewAlertEvidence } from "./alert-evidence-review.ts";
import { compareAlertEvidence } from "./alert-evidence-compare.ts";
import { AlertEvidenceFault } from "./alert-evidence.ts";
import { handoffHash, type HandoffReceipt } from "./alert-handoff-protocol.ts";

function single() {
  const f = alertEvidenceFixture();
  const trust = parseAlertEvidenceTrust({
    ...f.trustDocument,
    profiles: [f.trustDocument.profiles[0]],
  });
  return { ...f, trust, options: { now: f.reportedAt } };
}
function signReceipt(
  f: ReturnType<typeof single>,
  receipt: HandoffReceipt,
  patch: Partial<HandoffReceipt>,
) {
  const { signature: _, ...body } = { ...receipt, ...patch };
  return {
    ...body,
    signature: sign(
      null,
      Buffer.from(`no-wave-alert-receipt-v1\0${JSON.stringify(body)}`),
      f.sharedInbox.privateKey,
    ).toString("base64"),
  };
}

test("a complete public-only multi-source history is deterministic and distinguishes signed acceptance from health", () => {
  const f = alertEvidenceFixture(),
    trust = parseAlertEvidenceTrust(f.trustDocument);
  const a1 = f.batch(0, 1, null),
    b1 = f.batch(1, 1, null);
  const a2 = f.batch(0, 2, a1, { event: f.event(3, "resolved") });
  const inputs = evidenceInputs(
    [a2, b1, a1],
    [f.receipt(a1, 1), f.receipt(b1, 2), f.receipt(a2, 4)],
  );
  const report = reviewAlertEvidence(trust, inputs, { now: f.reportedAt });
  assert.equal(report.exitCode, 0);
  assert.equal(report.evidence, "signed_history_only");
  assert.equal(report.scope, "provided_artifacts_only");
  assert.equal(report.tailFinality, "not_proven");
  assert.deepEqual(report.findings, []);
  assert.equal(report.stats.batches, 3);
  assert.equal(report.stats.receipts, 3);
  assert.equal(report.stats.events, 3);
  assert.equal(
    report.streams.find((s) => s.streamId === a1.streamId)!.episodes
      .observedResolutions,
    1,
  );
  assert.equal(report.receiver.unobservedRevisions, 1);
  assert.deepEqual(
    reviewAlertEvidence(trust, [...inputs].reverse(), { now: f.reportedAt }),
    report,
  );
  const text = JSON.stringify(report);
  assert.doesNotMatch(
    text,
    /signingKey|senderKey|receiverKey|privateKey|metricsUrl|http:\/\//,
  );
});

test("missing prefixes, absent sources and missing/orphan receipts remain gaps, not false successful delivery", () => {
  const f = alertEvidenceFixture(),
    trust = parseAlertEvidenceTrust(f.trustDocument);
  const a1 = f.batch(0, 1, null),
    a2 = f.batch(0, 2, a1);
  const report = reviewAlertEvidence(
    trust,
    evidenceInputs([a2], [f.receipt(a1)]),
    { now: f.reportedAt },
  );
  assert.equal(report.exitCode, 1);
  for (const code of [
    "source_not_provided",
    "history_prefix_missing",
    "receipt_missing",
    "receipt_orphan",
    "episode_origin_unproven",
  ])
    assert.ok(
      report.findings.some((f) => f.code === code),
      code,
    );
  assert.equal(report.findingTotals.conflicts, 0);
  assert.equal(
    report.streams.find((s) => s.streamId === a2.streamId)!.chainCoverage,
    "partial",
  );
  const empty = reviewAlertEvidence(trust, [], { now: f.reportedAt });
  assert.equal(empty.stats.batches, 0);
  assert.equal(empty.findingTotals.gaps, 2);
});

test("authentic batch forks, missing sequence links and rollback are classified independently", () => {
  const f = single(),
    one = f.batch(0, 1, null);
  const two = f.batch(0, 2, one),
    fork = f.batch(0, 2, one, { preparedAt: two.preparedAt + 1 });
  const four = f.batch(0, 4, two);
  const report = reviewAlertEvidence(
    f.trust,
    evidenceInputs([one, two, fork, four]),
    f.options,
  );
  assert.ok(report.findings.some((i) => i.code === "sequence_fork"));
  assert.ok(report.findings.some((i) => i.code === "sequence_gap"));
  assert.ok(report.findingTotals.conflicts > 0);
  const wrongLink = f.batch(0, 2, one, { previousId: "a".repeat(64) });
  assert.ok(
    reviewAlertEvidence(
      f.trust,
      evidenceInputs([one, wrongLink]),
      f.options,
    ).findings.some((i) => i.code === "predecessor_mismatch"),
  );
  const backwards = f.batch(0, 2, one, { event: f.event(1, "firing") });
  const r = reviewAlertEvidence(
    f.trust,
    evidenceInputs([one, backwards]),
    f.options,
  );
  assert.ok(r.findings.some((i) => i.code === "source_revision_rollback"));
  assert.ok(r.findings.some((i) => i.code === "source_time_rollback"));
  assert.ok(r.findings.some((i) => i.code === "event_replayed"));
});

test("episode continuity crosses batch boundaries but a gap never fabricates a resolved incident", () => {
  const f = single(),
    first = f.batch(0, 1, null);
  const reopened = f.batch(0, 2, first, { event: f.event(3, "firing") });
  assert.ok(
    reviewAlertEvidence(
      f.trust,
      evidenceInputs([first, reopened]),
      f.options,
    ).findings.some((i) => i.code === "episode_start_while_open"),
  );
  const changed = f.batch(0, 2, first, {
    event: f.event(3, "reminder", { firingSince: f.now + 1 }),
  });
  assert.ok(
    reviewAlertEvidence(
      f.trust,
      evidenceInputs([first, changed]),
      f.options,
    ).findings.some((i) => i.code === "episode_origin_changed"),
  );
  const resolved = f.batch(0, 2, first, { event: f.event(3, "resolved") });
  const repeated = f.batch(0, 3, resolved);
  assert.ok(
    reviewAlertEvidence(
      f.trust,
      evidenceInputs([first, resolved, repeated]),
      f.options,
    ).findings.some((i) => i.code === "episode_after_resolution"),
  );
  const missing = f.batch(0, 4, repeated, { event: f.event(7, "resolved") });
  const partial = reviewAlertEvidence(
    f.trust,
    evidenceInputs([first, missing]),
    f.options,
  );
  assert.equal(partial.streams[0]!.episodes.observedResolutions, 0);
  assert.ok(partial.streams[0]!.episodes.unprovenOrigins > 0);
});

test("independently signed receipts cannot equivocate, reuse an inbox revision or rewind acceptance time", () => {
  const f = single(),
    first = f.batch(0, 1, null),
    second = f.batch(0, 2, first);
  const r1 = f.receipt(first, 2),
    r2 = f.receipt(second, 3);
  const equivocation = signReceipt(f, r1, { inboxRevision: 4 });
  const badCount = signReceipt(f, r2, { count: 2 });
  const result = reviewAlertEvidence(
    f.trust,
    evidenceInputs([first, second], [r1, equivocation, badCount]),
    f.options,
  );
  assert.ok(result.findings.some((i) => i.code === "receipt_equivocation"));
  assert.ok(result.findings.some((i) => i.code === "receipt_batch_mismatch"));
  const duplicateRevision = f.receipt(second, 2);
  assert.ok(
    reviewAlertEvidence(
      f.trust,
      evidenceInputs([first, second], [r1, duplicateRevision]),
      f.options,
    ).findings.some((i) => i.code === "inbox_revision_reused"),
  );
  const impossible = f.receipt(second, 1);
  const impossibleResult = reviewAlertEvidence(
    f.trust,
    evidenceInputs([first, second], [r1, impossible]),
    f.options,
  );
  assert.ok(
    impossibleResult.findings.some(
      (i) => i.code === "receipt_revision_impossible",
    ),
  );
  assert.ok(
    impossibleResult.findings.some(
      (i) => i.code === "receipt_sequence_rollback",
    ),
  );
  const delayedFirst = f.receipt(first, 1, second.preparedAt + 100);
  const clock = reviewAlertEvidence(
    f.trust,
    evidenceInputs([first, second], [delayedFirst, r2]),
    f.options,
  );
  assert.ok(clock.findings.some((i) => i.code === "inbox_time_rollback"));
  assert.ok(
    clock.findings.some(
      (i) => i.code === "preparation_before_previous_acceptance",
    ),
  );
});

test("a second signed claim prevents an unambiguous receipt count even when one claim matches", () => {
  const f = single(),
    batch = f.batch(0, 1, null),
    receipt = f.receipt(batch);
  const contradictory = signReceipt(f, receipt, { count: 2 });
  const report = reviewAlertEvidence(
    f.trust,
    evidenceInputs([batch], [receipt, contradictory]),
    f.options,
  );
  assert.equal(report.stats.unambiguousReceiptBatches, 0);
  assert.equal(report.stats.unambiguousSignedEventClaims, 0);
  assert.ok(
    report.findings.some(
      (finding) => finding.code === "receipt_batch_mismatch",
    ),
  );
  assert.equal(report.exitCode, 1);
  const unique = reviewAlertEvidence(
    f.trust,
    evidenceInputs([batch], [receipt, receipt]),
    f.options,
  );
  assert.equal(unique.stats.unambiguousReceiptBatches, 1);
  assert.equal(unique.stats.unambiguousSignedEventClaims, 1);
  assert.equal(unique.stats.duplicates, 1);
});

test("a source without supplied batches has an unknown episode tail, not an empty healthy tail", () => {
  const f = single();
  const report = reviewAlertEvidence(f.trust, [], f.options);
  assert.equal(report.streams[0]!.episodes.tailAmbiguous, true);
  assert.equal(report.streams[0]!.episodes.openAtTail, null);
  assert.equal(report.streams[0]!.episodes.provenOriginsAtTail, null);
  assert.deepEqual(report.streams[0]!.episodes.openTailSamples, []);
  assert.equal(report.exitCode, 1);
});

test("orphan receipts cannot reuse a source's signed terminal event at a later sequence", () => {
  const f = single(),
    first = f.batch(0, 1, null),
    second = f.batch(0, 2, first);
  const r1 = f.receipt(first),
    replay = signReceipt(f, f.receipt(second), { through: r1.through });
  const report = reviewAlertEvidence(
    f.trust,
    evidenceInputs([], [r1, replay]),
    f.options,
  );
  assert.ok(
    report.findings.some(
      (finding) => finding.code === "receipt_event_replayed",
    ),
  );
  assert.equal(report.stats.orphanReceipts, 2);
  const other = f.batch(1, 1, null),
    otherReceipt = f.receipt(other, 2);
  assert.equal(otherReceipt.through, r1.through);
  const namespaced = reviewAlertEvidence(
    parseAlertEvidenceTrust(f.trustDocument),
    evidenceInputs([], [r1, otherReceipt]),
    f.options,
  );
  assert.equal(
    namespaced.findings.some(
      (finding) => finding.code === "receipt_event_replayed",
    ),
    false,
  );
});

test("cross-source acceptance order is checked without assuming unexplained revisions were deliveries or consumption", () => {
  const f = alertEvidenceFixture(),
    trust = parseAlertEvidenceTrust(f.trustDocument);
  const a = f.batch(0, 1, null),
    b = f.batch(1, 1, null);
  const inputs = evidenceInputs(
    [a, b],
    [f.receipt(a, 4, a.preparedAt + 30), f.receipt(b, 5, b.preparedAt + 10)],
  );
  const report = reviewAlertEvidence(trust, inputs, { now: f.reportedAt });
  assert.ok(report.findings.some((i) => i.code === "inbox_time_rollback"));
  assert.equal(report.receiver.unobservedRevisions, 3);
  assert.equal(report.receiver.consumptionProof, "not_provided");
});

test("one receiver revision must cover the signed per-source sequence lower bounds without inventing revision-hole deliveries", () => {
  const f = alertEvidenceFixture(),
    trust = parseAlertEvidenceTrust(f.trustDocument);
  const a1 = f.batch(0, 1, null),
    a2 = f.batch(0, 2, a1),
    a3 = f.batch(0, 3, a2);
  const b1 = f.batch(1, 1, null),
    b2 = f.batch(1, 2, b1);
  const a = f.receipt(a3, 3),
    b = f.receipt(b2, 4, a.acceptedAt + 1);
  const report = reviewAlertEvidence(trust, evidenceInputs([a3, b2], [a, b]), {
    now: f.reportedAt,
  });
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.code === "receipt_revision_impossible" &&
        finding.streamId === b.streamId,
    ),
  );
  assert.equal(report.receiver.minimumReceivesClaimed, "5");
  const sparse = reviewAlertEvidence(
    trust,
    evidenceInputs([a3, b2], [a, f.receipt(b2, 8, a.acceptedAt + 1)]),
    { now: f.reportedAt },
  );
  assert.equal(
    sparse.findings.some(
      (finding) => finding.code === "receipt_revision_impossible",
    ),
    false,
  );
  assert.equal(sparse.receiver.minimumReceivesClaimed, "5");
  assert.equal(sparse.receiver.unobservedRevisions, 6);
  assert.equal(sparse.receiver.consumptionProof, "not_provided");
});

test("cross-source revision lower bounds stay exact when their sum exceeds safe numeric range", () => {
  const f = alertEvidenceFixture(),
    trust = parseAlertEvidenceTrust(f.trustDocument);
  const earlier = f.batch(1, 1, null);
  const huge = f.batch(0, Number.MAX_SAFE_INTEGER, null, {
    event: f.event(3, "reminder"),
    previousId: "a".repeat(64),
  });
  const report = reviewAlertEvidence(
    trust,
    evidenceInputs(
      [earlier, huge],
      [
        f.receipt(earlier, Number.MAX_SAFE_INTEGER - 1),
        f.receipt(huge, Number.MAX_SAFE_INTEGER),
      ],
    ),
    { now: f.reportedAt },
  );
  assert.equal(report.receiver.minimumReceivesClaimed, "9007199254740992");
  assert.ok(
    report.findings.some(
      (finding) =>
        finding.code === "receipt_revision_impossible" &&
        finding.streamId === huge.streamId,
    ),
  );
});

test("old authentic evidence is not refreshed, and a future signed timestamp is rejected", () => {
  const f = single(),
    batch = f.batch(0, 1, null),
    receipt = f.receipt(batch);
  const inputs = evidenceInputs([batch], [receipt]);
  const report = reviewAlertEvidence(f.trust, inputs, {
    now: f.reportedAt,
    maxAgeMs: 1000,
  });
  assert.equal(report.exitCode, 1);
  assert.ok(report.findings.some((i) => i.code === "evidence_stale"));
  assert.equal(report.streams[0]!.oldestEventAt, batch.events[0]!.at);
  assert.throws(
    () => reviewAlertEvidence(f.trust, inputs, { now: batch.preparedAt }),
    { code: "clock_rollback" },
  );
  assert.throws(
    () => reviewAlertEvidence(f.trust, inputs, { now: Number.NaN }),
    { code: "arguments_invalid" },
  );
});

test("fresh supplied events cannot hide the age of an older orphan signed receipt", () => {
  const f = single(),
    older = f.batch(0, 1, null),
    oldReceipt = f.receipt(older);
  const fresh = f.batch(0, 2, older, { event: f.event(31, "reminder") });
  const freshReceipt = f.receipt(fresh),
    options = { now: freshReceipt.acceptedAt + 1, maxAgeMs: 1000 };
  const onlyFresh = reviewAlertEvidence(
    f.trust,
    evidenceInputs([fresh], [freshReceipt]),
    options,
  );
  assert.equal(
    onlyFresh.findings.some((finding) => finding.code === "evidence_stale"),
    false,
  );
  const withOlder = reviewAlertEvidence(
    f.trust,
    evidenceInputs([fresh], [oldReceipt, freshReceipt]),
    options,
  );
  assert.ok(
    withOlder.findings.some((finding) => finding.code === "receipt_orphan"),
  );
  assert.ok(
    withOlder.findings.some((finding) => finding.code === "evidence_stale"),
  );
  assert.equal(withOlder.streams[0]!.oldestAcceptedAt, oldReceipt.acceptedAt);
});

test("public trust rejects private keys, peer changes, duplicate identities and mixed receivers", () => {
  const f = single();
  const first = f.trustDocument.profiles[0]!,
    second = f.trustDocument.profiles[1]!;
  for (const profiles of [
    [],
    [first, first],
    [first, { ...second, streamId: first.streamId }],
    [first, { ...second, senderKey: first.senderKey }],
    [{ ...first, signingKey: f.senderDocument.signingKey }],
    [first, { ...second, receiverId: f.senders[1]!.streamId }],
    [first, { ...second, receiverKey: second.senderKey }],
  ])
    assert.throws(
      () => parseAlertEvidenceTrust({ ...f.trustDocument, profiles }),
      { code: "trust_invalid" },
    );
  const batch = f.batch(0, 1, null),
    forged = { ...batch, preparedAt: batch.preparedAt + 1 };
  assert.throws(
    () =>
      reviewAlertEvidence(
        f.trust,
        [{ kind: "batch", bytes: Buffer.from(JSON.stringify(forged)) }],
        f.options,
      ),
    { code: "artifact_invalid" },
  );
  const untrusted = f.batch(1, 1, null);
  assert.throws(
    () => reviewAlertEvidence(f.trust, evidenceInputs([untrusted]), f.options),
    { code: "artifact_invalid" },
  );
});

test("canonical duplicates and serialization order do not manufacture new facts or comparison progress", () => {
  const f = single(),
    one = f.batch(0, 1, null),
    r = f.receipt(one);
  const original = evidenceInputs([one], [r]);
  const duplicate = [
    {
      kind: "batch" as const,
      bytes: Buffer.from(JSON.stringify(one, null, 2)),
    },
    ...original,
  ];
  const report = reviewAlertEvidence(f.trust, duplicate, f.options);
  assert.equal(report.stats.duplicates, 1);
  assert.equal(report.stats.events, 1);
  assert.equal(
    report.evidenceId,
    reviewAlertEvidence(f.trust, original, f.options).evidenceId,
  );
  const compared = compareAlertEvidence(
    f.trust,
    original,
    duplicate.reverse(),
    f.options,
  );
  assert.equal(compared.change, "unchanged");
  assert.deepEqual(compared.added, { batches: 0, receipts: 0 });
});

test("comparison preserves absent proof, classifies rollback and never repairs a fork by hiding old artifacts", () => {
  const f = single(),
    first = f.batch(0, 1, null),
    second = f.batch(0, 2, first);
  const r1 = f.receipt(first),
    r2 = f.receipt(second);
  const before = evidenceInputs([first], [r1]),
    after = evidenceInputs([first, second], [r1, r2]);
  const extension = compareAlertEvidence(f.trust, before, after, f.options);
  assert.equal(extension.change, "extended");
  assert.equal(extension.exitCode, 0);
  assert.deepEqual(extension.added, { batches: 1, receipts: 1 });
  const removed = compareAlertEvidence(
    f.trust,
    before,
    evidenceInputs([second], [r2]),
    f.options,
  );
  assert.equal(removed.change, "regressed");
  assert.equal(removed.exitCode, 1);
  assert.deepEqual(removed.removed, { batches: 1, receipts: 1 });
  const fork = f.batch(0, 2, first, { preparedAt: second.preparedAt + 1 });
  assert.equal(
    compareAlertEvidence(
      f.trust,
      after,
      evidenceInputs([first, second, fork], [r1, r2]),
      f.options,
    ).change,
    "conflicting",
  );
  const initial = compareAlertEvidence(f.trust, [], before, f.options);
  assert.equal(initial.change, "incomparable");
  assert.equal(initial.exitCode, 1);
});

test("bounded input and malformed material fail closed rather than returning partial trusted reports", () => {
  const f = single();
  for (const bytes of [
    Buffer.from('{"signingKey":"secret-input-canary"'),
    Buffer.from([0xff]),
    Buffer.from("null"),
  ])
    assert.throws(
      () => reviewAlertEvidence(f.trust, [{ kind: "batch", bytes }], f.options),
      (error: unknown) =>
        error instanceof AlertEvidenceFault &&
        error.code === "artifact_invalid",
    );
  const batch = f.batch(0, 1, null),
    input = evidenceInputs([batch])[0]!;
  assert.throws(
    () =>
      reviewAlertEvidence(
        f.trust,
        Array.from({ length: 257 }, () => input),
        f.options,
      ),
    { code: "budget_exceeded" },
  );
  assert.throws(
    () =>
      reviewAlertEvidence(
        f.trust,
        [{ kind: "batch", bytes: Buffer.alloc(256 * 1024 + 1) }],
        f.options,
      ),
    { code: "budget_exceeded" },
  );
  assert.throws(
    () =>
      reviewAlertEvidence(f.trust, [input], { now: f.reportedAt, maxAgeMs: 0 }),
    { code: "arguments_invalid" },
  );
  assert.equal(handoffHash({ a: 1 }).length, 64);
});
