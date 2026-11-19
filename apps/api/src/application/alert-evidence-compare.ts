import { handoffHash } from "./alert-handoff-protocol.ts";
import {
  analyzeAlertEvidence,
  reviewAuthenticatedEvidence,
} from "./alert-evidence-review.ts";
import {
  EvidenceFindings,
  evidenceBatchOrder,
  evidenceBatchScope,
  evidenceReceiptId,
  evidenceReceiptOrder,
  evidenceReceiptScope,
  type AlertEvidenceTrust,
  type AuthenticatedEvidence,
  type EvidenceInput,
  type EvidenceOptions,
} from "./alert-evidence.ts";

/** The union is bounded by two independently admitted sets, not re-admitted as
 * one smaller set. Reusing authenticated records avoids a second trust path. */
function unionEvidence(
  trust: AlertEvidenceTrust,
  before: AuthenticatedEvidence,
  after: AuthenticatedEvidence,
): AuthenticatedEvidence {
  const batches = new Map(before.batches.map((batch) => [batch.id, batch]));
  const receipts = new Map(
    before.receipts.map((receipt) => [evidenceReceiptId(receipt), receipt]),
  );
  for (const batch of after.batches) batches.set(batch.id, batch);
  for (const receipt of after.receipts)
    receipts.set(evidenceReceiptId(receipt), receipt);
  const artifactIds = [
    ...new Set([...before.artifactIds, ...after.artifactIds]),
  ].sort();
  let events = 0;
  for (const batch of batches.values()) events += batch.events.length;
  return {
    batches: [...batches.values()].sort(evidenceBatchOrder),
    receipts: [...receipts.values()].sort(evidenceReceiptOrder),
    artifactIds,
    events,
    totalBytes: before.totalBytes + after.totalBytes,
    duplicates:
      before.duplicates +
      after.duplicates +
      before.artifactIds.length +
      after.artifactIds.length -
      artifactIds.length,
    evidenceId: handoffHash([
      "no-wave-alert-evidence-set-v1",
      trust.fingerprint,
      artifactIds,
    ]),
  };
}
function kindCounts(ids: readonly string[]) {
  let batches = 0,
    receipts = 0;
  for (const id of ids) {
    if (id.startsWith("batch:")) batches++;
    else receipts++;
  }
  return { batches, receipts };
}

/** A comparison is an artifact-set relation, not proof of operational progress.
 * Retaining and reviewing the union is essential: replacing old evidence with
 * a new clean-looking fork must not erase the previously observed conflict. */
export function compareAlertEvidence(
  trust: AlertEvidenceTrust,
  beforeInputs: readonly EvidenceInput[],
  afterInputs: readonly EvidenceInput[],
  options: EvidenceOptions,
) {
  const before = analyzeAlertEvidence(trust, beforeInputs, options);
  const after = analyzeAlertEvidence(trust, afterInputs, options);
  const combined = unionEvidence(trust, before.evidence, after.evidence);
  const union = reviewAuthenticatedEvidence(trust, combined, options);
  const beforeIds = new Set(before.evidence.artifactIds),
    afterIds = new Set(after.evidence.artifactIds);
  const addedIds = after.evidence.artifactIds.filter(
    (id) => !beforeIds.has(id),
  );
  const removedIds = before.evidence.artifactIds.filter(
    (id) => !afterIds.has(id),
  );
  const retainedIds = before.evidence.artifactIds.filter((id) =>
    afterIds.has(id),
  );
  const regressions = new EvidenceFindings();
  const removed = new Set(removedIds);
  for (const batch of before.evidence.batches)
    if (removed.has(`batch:${batch.id}`))
      regressions.add(
        "batch_evidence_removed",
        "gap",
        evidenceBatchScope(batch),
      );
  for (const receipt of before.evidence.receipts)
    if (removed.has(`receipt:${evidenceReceiptId(receipt)}`))
      regressions.add(
        "receipt_evidence_removed",
        "gap",
        evidenceReceiptScope(receipt),
      );
  const streams = before.report.streams.map((prior) => {
    const next = after.report.streams.find(
      (source) => source.streamId === prior.streamId,
    )!;
    const missingTips = prior.tipBatchIds.filter(
      (id) => !next.tipBatchIds.includes(id),
    );
    if (
      prior.lastSequence !== null &&
      (next.lastSequence === null || next.lastSequence < prior.lastSequence)
    )
      regressions.add("stream_tip_rollback", "gap", {
        streamId: prior.streamId,
        sequence: prior.lastSequence,
        batchId: prior.tipBatchIds[0] ?? null,
      });
    else if (
      prior.lastSequence !== null &&
      prior.lastSequence === next.lastSequence &&
      missingTips.length > 0
    )
      regressions.add("stream_tip_replaced", "conflict", {
        streamId: prior.streamId,
        sequence: prior.lastSequence,
        batchId: next.tipBatchIds[0] ?? null,
        relatedId: missingTips[0]!,
      });
    const priorBatches = before.evidence.batches.filter(
      (batch) => batch.streamId === prior.streamId,
    );
    const nextBatches = after.evidence.batches.filter(
      (batch) => batch.streamId === prior.streamId,
    );
    const priorReceipts = before.evidence.receipts.filter(
      (receipt) => receipt.streamId === prior.streamId,
    );
    const nextReceipts = after.evidence.receipts.filter(
      (receipt) => receipt.streamId === prior.streamId,
    );
    const removedBatches = priorBatches.filter(
      (batch) => !afterIds.has(`batch:${batch.id}`),
    ).length;
    const removedReceipts = priorReceipts.filter(
      (receipt) => !afterIds.has(`receipt:${evidenceReceiptId(receipt)}`),
    ).length;
    const addedBatches = nextBatches.filter(
      (batch) => !beforeIds.has(`batch:${batch.id}`),
    ).length;
    const addedReceipts = nextReceipts.filter(
      (receipt) => !beforeIds.has(`receipt:${evidenceReceiptId(receipt)}`),
    ).length;
    return {
      streamId: prior.streamId,
      beforeSequence: prior.lastSequence,
      afterSequence: next.lastSequence,
      addedBatches,
      removedBatches,
      addedReceipts,
      removedReceipts,
    };
  });
  const previousRevision = before.report.receiver.lastRevision,
    nextRevision = after.report.receiver.lastRevision;
  if (
    previousRevision !== null &&
    (nextRevision === null || nextRevision < previousRevision)
  )
    regressions.add("receiver_revision_rollback", "gap");
  const baselineEmpty =
    before.evidence.artifactIds.length === 0 &&
    after.evidence.artifactIds.length > 0;
  if (baselineEmpty) regressions.add("comparison_baseline_empty", "gap");
  const change =
    union.findingTotals.conflicts > 0
      ? "conflicting"
      : removedIds.length > 0
        ? "regressed"
        : baselineEmpty
          ? "incomparable"
          : addedIds.length === 0
            ? "unchanged"
            : "extended";
  const regressionTotals = regressions.summary();
  return {
    version: 1,
    event: "alert_evidence_comparison",
    evidence: "signed_history_only",
    assessment: "artifact_set_relation_not_service_progress",
    reportedAt: options.now,
    trustFingerprint: trust.fingerprint,
    change,
    before: before.report,
    after: after.report,
    added: kindCounts(addedIds),
    removed: kindCounts(removedIds),
    retained: kindCounts(retainedIds),
    artifactChanges: {
      added: addedIds.slice(0, 64),
      removed: removedIds.slice(0, 64),
      truncated: addedIds.length > 64 || removedIds.length > 64,
    },
    streams,
    combinedEvidence: {
      evidenceId: union.evidenceId,
      stats: union.stats,
      findingTotals: union.findingTotals,
      findings: union.findings,
    },
    regressionTotals,
    regressions: regressions.list(),
    exitCode: (change === "conflicting" ||
    change === "regressed" ||
    change === "incomparable" ||
    after.report.exitCode !== 0 ||
    regressionTotals.total > 0
      ? 1
      : 0) as 0 | 1,
  };
}
