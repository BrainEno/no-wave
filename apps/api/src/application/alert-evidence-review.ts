import { authenticateAlertEvidence } from "./alert-evidence-authentication.ts";
import { reviewEvidenceHistory } from "./alert-evidence-history.ts";
import { reviewEvidenceEpisodes } from "./alert-evidence-episodes.ts";
import { reviewEvidenceReceipts } from "./alert-evidence-receipts.ts";
import {
  EvidenceFindings,
  evidenceOptions,
  type AlertEvidenceTrust,
  type AuthenticatedEvidence,
  type EvidenceInput,
  type EvidenceOptions,
} from "./alert-evidence.ts";

/** Internal policy for already authenticated material, including a comparison's
 * bounded union. Do not call this with unchecked artifacts. */
export function reviewAuthenticatedEvidence(
  trust: AlertEvidenceTrust,
  evidence: AuthenticatedEvidence,
  options: EvidenceOptions,
  findings = new EvidenceFindings(),
) {
  const { now, maxAgeMs } = evidenceOptions(options);
  const histories = reviewEvidenceHistory(trust, evidence, findings);
  const receipts = reviewEvidenceReceipts(trust, evidence, findings);
  const streams = histories.map((history) => {
    const episodes = reviewEvidenceEpisodes(history, findings);
    let oldestEventAt: number | null = null,
      newestEventAt: number | null = null;
    let oldestPreparedAt: number | null = null,
      newestPreparedAt: number | null = null;
    let count = 0,
      unreceiptedBatches = 0;
    const fingerprints = new Set<string>();
    for (const batch of history.batches) {
      count += batch.events.length;
      fingerprints.add(batch.monitorFingerprint);
      if (!receipts.matched.has(batch.id)) unreceiptedBatches++;
      const first = batch.events[0]!.at,
        last = batch.events.at(-1)!.at;
      if (oldestEventAt === null || first < oldestEventAt)
        oldestEventAt = first;
      if (newestEventAt === null || last > newestEventAt) newestEventAt = last;
      if (oldestPreparedAt === null || batch.preparedAt < oldestPreparedAt)
        oldestPreparedAt = batch.preparedAt;
      if (newestPreparedAt === null || batch.preparedAt > newestPreparedAt)
        newestPreparedAt = batch.preparedAt;
    }
    const sourceReceipts = evidence.receipts.filter(
      (receipt) => receipt.streamId === history.streamId,
    );
    let oldestAcceptedAt: number | null = null,
      newestAcceptedAt: number | null = null;
    for (const receipt of sourceReceipts) {
      if (oldestAcceptedAt === null || receipt.acceptedAt < oldestAcceptedAt)
        oldestAcceptedAt = receipt.acceptedAt;
      if (newestAcceptedAt === null || receipt.acceptedAt > newestAcceptedAt)
        newestAcceptedAt = receipt.acceptedAt;
    }
    const oldestFact =
      oldestEventAt === null
        ? oldestAcceptedAt
        : oldestAcceptedAt === null
          ? oldestEventAt
          : Math.min(oldestEventAt, oldestAcceptedAt);
    if (oldestFact !== null && now - oldestFact > maxAgeMs)
      findings.add("evidence_stale", "warning", {
        streamId: history.streamId,
        sequence: history.firstSequence,
        batchId: history.batches[0]?.id ?? null,
      });
    return {
      streamId: history.streamId,
      batches: history.batches.length,
      receipts: sourceReceipts.length,
      events: count,
      firstSequence: history.firstSequence,
      lastSequence: history.lastSequence,
      tipBatchIds: history.batches
        .filter((batch) => batch.sequence === history.lastSequence)
        .map((batch) => batch.id)
        .sort(),
      chainCoverage: history.chainCoverage,
      missingSequences: history.missingSequences,
      forkedSequences: history.forkedSequences,
      monitorConfigurations: fingerprints.size,
      unreceiptedBatches,
      oldestEventAt,
      newestEventAt,
      oldestPreparedAt,
      newestPreparedAt,
      oldestAcceptedAt,
      newestAcceptedAt,
      oldestEventAgeMs: oldestEventAt === null ? null : now - oldestEventAt,
      newestEventAgeMs: newestEventAt === null ? null : now - newestEventAt,
      oldestAcceptanceAgeMs:
        oldestAcceptedAt === null ? null : now - oldestAcceptedAt,
      newestAcceptanceAgeMs:
        newestAcceptedAt === null ? null : now - newestAcceptedAt,
      episodes,
    };
  });
  const findingTotals = findings.summary();
  const report = {
    version: 1,
    event: "alert_evidence_review",
    evidence: "signed_history_only",
    scope: "provided_artifacts_only",
    tailFinality: "not_proven",
    serviceHealth: "not_assessed",
    humanDelivery: "not_assessed",
    reportedAt: now,
    maxAgeMs,
    trustFingerprint: trust.fingerprint,
    evidenceId: evidence.evidenceId,
    stats: {
      artifacts: evidence.artifactIds.length,
      batches: evidence.batches.length,
      receipts: evidence.receipts.length,
      events: evidence.events,
      duplicates: evidence.duplicates,
      inputBytes: evidence.totalBytes,
      missingReceipts: receipts.missingReceipts,
      orphanReceipts: receipts.orphanReceipts,
      mismatchedReceipts: receipts.mismatchedReceipts,
      unambiguousReceiptBatches: receipts.unambiguousReceiptBatches,
      unambiguousSignedEventClaims: receipts.unambiguousSignedEventClaims,
    },
    streams,
    receiver: receipts.receiver,
    findingTotals,
    findings: findings.list(),
    exitCode: (findingTotals.total > 0 ? 1 : 0) as 0 | 1,
  };
  return report;
}

/** Authenticated internals are shared only by evidence review policies. Public
 * reports contain bounded facts, never raw artifacts, keys or filesystem paths. */
export function analyzeAlertEvidence(
  trust: AlertEvidenceTrust,
  inputs: readonly EvidenceInput[],
  options: EvidenceOptions,
) {
  const { now } = evidenceOptions(options);
  const evidence = authenticateAlertEvidence(trust, inputs, now);
  const findings = new EvidenceFindings();
  return {
    evidence,
    findings,
    report: reviewAuthenticatedEvidence(trust, evidence, options, findings),
  };
}
export function reviewAlertEvidence(
  trust: AlertEvidenceTrust,
  inputs: readonly EvidenceInput[],
  options: EvidenceOptions,
) {
  return analyzeAlertEvidence(trust, inputs, options).report;
}
