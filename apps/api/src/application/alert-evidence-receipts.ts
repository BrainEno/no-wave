import {
  verifyHandoffReceipt,
  type HandoffReceipt,
} from "./alert-handoff-protocol.ts";
import {
  EvidenceFindings,
  evidenceBatchScope,
  evidenceReceiptId,
  evidenceReceiptScope,
  type AlertEvidenceTrust,
  type AuthenticatedEvidence,
} from "./alert-evidence.ts";

/** Receipts from one pinned receiver share a global inbox revision. Missing
 * revision numbers are deliberately not classified as consumption or delivery:
 * other receives and explicit consumes can both advance that journal. */
export function reviewEvidenceReceipts(
  trust: AlertEvidenceTrust,
  evidence: AuthenticatedEvidence,
  findings: EvidenceFindings,
) {
  const batches = new Map(evidence.batches.map((batch) => [batch.id, batch]));
  const matched = new Map<string, HandoffReceipt[]>();
  const sourceSequences = new Map<string, HandoffReceipt[]>();
  const revisions = new Map<number, HandoffReceipt[]>();
  const terminalEvents = new Map<string, HandoffReceipt>();
  let orphanReceipts = 0,
    mismatchedReceipts = 0;
  for (const receipt of evidence.receipts) {
    const scope = evidenceReceiptScope(receipt);
    const terminalKey = `${receipt.streamId}:${receipt.through}`;
    const previousTerminal = terminalEvents.get(terminalKey);
    if (previousTerminal === undefined)
      terminalEvents.set(terminalKey, receipt);
    else if (previousTerminal.sequence !== receipt.sequence)
      findings.add("receipt_event_replayed", "conflict", {
        ...scope,
        relatedId: evidenceReceiptId(previousTerminal),
      });
    const sourceSequence = `${receipt.streamId}:${receipt.sequence}`;
    const sameSequence = sourceSequences.get(sourceSequence) ?? [];
    sameSequence.push(receipt);
    sourceSequences.set(sourceSequence, sameSequence);
    const sameRevision = revisions.get(receipt.inboxRevision) ?? [];
    sameRevision.push(receipt);
    revisions.set(receipt.inboxRevision, sameRevision);
    if (receipt.inboxRevision < receipt.sequence)
      findings.add("receipt_revision_impossible", "conflict", scope);
    const batch = batches.get(receipt.batchId);
    if (!batch) {
      orphanReceipts++;
      findings.add("receipt_orphan", "gap", scope);
      continue;
    }
    try {
      verifyHandoffReceipt(receipt, trust.byStream.get(batch.streamId)!, batch);
    } catch {
      mismatchedReceipts++;
      findings.add("receipt_batch_mismatch", "conflict", scope);
      continue;
    }
    const receipts = matched.get(batch.id) ?? [];
    receipts.push(receipt);
    matched.set(batch.id, receipts);
  }
  for (const group of sourceSequences.values()) {
    const first = group[0]!;
    for (const receipt of group.slice(1))
      findings.add("receipt_equivocation", "conflict", {
        ...evidenceReceiptScope(receipt),
        relatedId: evidenceReceiptId(first),
      });
  }
  let missingReceipts = 0,
    unambiguousReceiptBatches = 0,
    unambiguousSignedEventClaims = 0;
  for (const batch of evidence.batches) {
    const receipts = matched.get(batch.id) ?? [];
    if (receipts.length === 0) {
      missingReceipts++;
      findings.add("receipt_missing", "gap", evidenceBatchScope(batch));
    } else if (
      receipts.length === 1 &&
      sourceSequences.get(`${batch.streamId}:${batch.sequence}`)!.length === 1
    ) {
      unambiguousReceiptBatches++;
      unambiguousSignedEventClaims += batch.events.length;
    }
    if (batch.previous === null) continue;
    for (const receipt of matched.get(batch.previous) ?? []) {
      if (
        receipt.streamId === batch.streamId &&
        receipt.sequence === batch.sequence - 1 &&
        batch.preparedAt < receipt.acceptedAt
      )
        findings.add("preparation_before_previous_acceptance", "conflict", {
          ...evidenceBatchScope(batch),
          relatedId: evidenceReceiptId(receipt),
        });
    }
  }
  for (const profile of trust.profiles) {
    const receipts = evidence.receipts.filter(
      (receipt) => receipt.streamId === profile.streamId,
    );
    let priorSequence: number | null = null;
    let greatestRevision: HandoffReceipt | null = null;
    let latestAcceptance: HandoffReceipt | null = null;
    let group: HandoffReceipt[] = [];
    const inspect = () => {
      for (const receipt of group) {
        if (
          greatestRevision &&
          receipt.inboxRevision <= greatestRevision.inboxRevision
        )
          findings.add("receipt_sequence_rollback", "conflict", {
            ...evidenceReceiptScope(receipt),
            relatedId: evidenceReceiptId(greatestRevision),
          });
        if (
          latestAcceptance &&
          receipt.acceptedAt < latestAcceptance.acceptedAt
        )
          findings.add("receipt_time_rollback", "conflict", {
            ...evidenceReceiptScope(receipt),
            relatedId: evidenceReceiptId(latestAcceptance),
          });
      }
      for (const receipt of group) {
        if (
          greatestRevision === null ||
          receipt.inboxRevision > greatestRevision.inboxRevision
        )
          greatestRevision = receipt;
        if (
          latestAcceptance === null ||
          receipt.acceptedAt > latestAcceptance.acceptedAt
        )
          latestAcceptance = receipt;
      }
    };
    for (const receipt of receipts) {
      if (priorSequence !== null && receipt.sequence !== priorSequence) {
        inspect();
        group = [];
      }
      group.push(receipt);
      priorSequence = receipt.sequence;
    }
    inspect();
  }
  const orderedRevisions = [...revisions.keys()].sort((a, b) => a - b);
  let latestAcceptance: HandoffReceipt | null = null;
  const observedSequences = new Map<string, number>();
  let minimumReceives = 0n;
  for (const revision of orderedRevisions) {
    const group = revisions.get(revision)!;
    // Reaching sequence N requires at least N receives for that source. Sum
    // only these signed lower bounds, never classify a revision hole as a
    // delivery or consumption. BigInt avoids overflow across pinned sources.
    for (const receipt of group) {
      const prior = observedSequences.get(receipt.streamId) ?? 0;
      if (receipt.sequence > prior) {
        minimumReceives += BigInt(receipt.sequence) - BigInt(prior);
        observedSequences.set(receipt.streamId, receipt.sequence);
      }
    }
    if (minimumReceives > BigInt(revision))
      for (const receipt of group)
        findings.add(
          "receipt_revision_impossible",
          "conflict",
          evidenceReceiptScope(receipt),
        );
    const first = group[0]!;
    for (const receipt of group.slice(1))
      findings.add("inbox_revision_reused", "conflict", {
        ...evidenceReceiptScope(receipt),
        relatedId: evidenceReceiptId(first),
      });
    for (const receipt of group) {
      if (latestAcceptance && receipt.acceptedAt < latestAcceptance.acceptedAt)
        findings.add("inbox_time_rollback", "conflict", {
          ...evidenceReceiptScope(receipt),
          relatedId: evidenceReceiptId(latestAcceptance),
        });
    }
    for (const receipt of group)
      if (
        latestAcceptance === null ||
        receipt.acceptedAt > latestAcceptance.acceptedAt
      )
        latestAcceptance = receipt;
  }
  const lastRevision = orderedRevisions.at(-1) ?? null;
  return {
    matched,
    missingReceipts,
    orphanReceipts,
    mismatchedReceipts,
    unambiguousReceiptBatches,
    unambiguousSignedEventClaims,
    receiver: {
      receiverId: trust.receiverId,
      firstRevision: orderedRevisions[0] ?? null,
      lastRevision,
      distinctRevisions: orderedRevisions.length,
      minimumReceivesClaimed: minimumReceives.toString(),
      unobservedRevisions:
        lastRevision === null ? 0 : lastRevision - orderedRevisions.length,
      latestAcceptanceAt: latestAcceptance?.acceptedAt ?? null,
      consumptionProof: "not_provided" as const,
      physicalDurabilityProof: "not_provided" as const,
    },
  };
}
