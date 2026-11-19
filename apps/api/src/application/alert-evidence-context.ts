import {
  handoffHash,
  verifyHandoffReceipt,
  type HandoffBatch,
} from "./alert-handoff-protocol.ts";
import type { MonitorEvent } from "./operational-monitor.ts";
import {
  evidenceReceiptId,
  type AlertEvidenceTrust,
  type AuthenticatedEvidence,
} from "./alert-evidence.ts";

export type EvidenceTraceFact = {
  rowId: string;
  batch: HandoffBatch;
  event: MonitorEvent;
};
function factOrder(a: EvidenceTraceFact, b: EvidenceTraceFact): number {
  if (a.event.at !== b.event.at) return a.event.at - b.event.at;
  if (a.batch.streamId !== b.batch.streamId)
    return a.batch.streamId < b.batch.streamId ? -1 : 1;
  if (a.event.revision !== b.event.revision)
    return a.event.revision - b.event.revision;
  if (a.batch.sequence !== b.batch.sequence)
    return a.batch.sequence - b.batch.sequence;
  return a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0;
}
export function buildEvidenceTraceContext(
  trust: AlertEvidenceTrust,
  evidence: AuthenticatedEvidence,
) {
  const byId = new Map(evidence.batches.map((batch) => [batch.id, batch]));
  const bySequence = new Map<string, HandoffBatch[]>(),
    children = new Map<string, HandoffBatch[]>();
  const ruleFacts = new Map<string, EvidenceTraceFact[]>(),
    facts: EvidenceTraceFact[] = [];
  for (const batch of evidence.batches) {
    const sequenceKey = `${batch.streamId}:${batch.sequence}`;
    const group = bySequence.get(sequenceKey) ?? [];
    group.push(batch);
    bySequence.set(sequenceKey, group);
    if (batch.previous !== null) {
      const successors = children.get(batch.previous) ?? [];
      successors.push(batch);
      children.set(batch.previous, successors);
    }
    for (const event of batch.events) {
      const fact = {
        rowId: handoffHash([
          "no-wave-alert-evidence-event-v1",
          batch.streamId,
          batch.id,
          event.id,
        ]),
        batch,
        event,
      };
      facts.push(fact);
      const ruleKey = `${batch.streamId}:${batch.monitorFingerprint}:${event.targetId}:${event.rule}`;
      const existing = ruleFacts.get(ruleKey) ?? [];
      existing.push(fact);
      ruleFacts.set(ruleKey, existing);
    }
  }
  facts.sort(factOrder);
  const neighbors = new Map<
    string,
    { previous: EvidenceTraceFact | null; next: EvidenceTraceFact | null }
  >();
  for (const group of ruleFacts.values()) {
    group.sort(factOrder);
    for (let index = 0; index < group.length; index++)
      neighbors.set(group[index]!.rowId, {
        previous: group[index - 1] ?? null,
        next: group[index + 1] ?? null,
      });
  }
  const receiptClaims = new Map<
    string,
    {
      receiptId: string;
      acceptedAt: number;
      inboxRevision: number;
      matchesBatch: boolean;
    }[]
  >();
  const sourceReceiptCounts = new Map<string, number>();
  for (const receipt of evidence.receipts) {
    const sequenceKey = `${receipt.streamId}:${receipt.sequence}`;
    sourceReceiptCounts.set(
      sequenceKey,
      (sourceReceiptCounts.get(sequenceKey) ?? 0) + 1,
    );
    const batch = byId.get(receipt.batchId);
    if (!batch) continue;
    let matchesBatch = true;
    try {
      verifyHandoffReceipt(receipt, trust.byStream.get(batch.streamId)!, batch);
    } catch {
      matchesBatch = false;
    }
    const claims = receiptClaims.get(batch.id) ?? [];
    claims.push({
      receiptId: evidenceReceiptId(receipt),
      acceptedAt: receipt.acceptedAt,
      inboxRevision: receipt.inboxRevision,
      matchesBatch,
    });
    receiptClaims.set(batch.id, claims);
  }
  return {
    facts,
    byId,
    bySequence,
    children,
    neighbors,
    receiptClaims,
    sourceReceiptCounts,
  };
}
type Context = ReturnType<typeof buildEvidenceTraceContext>;

/** Only provided graph linkage is asserted. A nearest fact outside the query
 * window is not assumed to be the immediately preceding real-world event. */
function linkage(
  context: Context,
  earlier: EvidenceTraceFact,
  later: EvidenceTraceFact,
): "same_batch" | "linked_batches" | "unproven" {
  if (earlier.batch.id === later.batch.id) return "same_batch";
  if (
    earlier.batch.streamId !== later.batch.streamId ||
    earlier.batch.sequence >= later.batch.sequence ||
    earlier.event.at >= later.event.at ||
    earlier.event.revision >= later.event.revision
  )
    return "unproven";
  let current = later.batch;
  const visited = new Set<string>();
  while (current.id !== earlier.batch.id) {
    if (
      visited.has(current.id) ||
      visited.size > context.byId.size ||
      context.bySequence.get(`${current.streamId}:${current.sequence}`)!
        .length !== 1
    )
      return "unproven";
    visited.add(current.id);
    if (
      current.monitorFingerprint !== earlier.batch.monitorFingerprint ||
      current.previous === null
    )
      return "unproven";
    const parent = context.byId.get(current.previous);
    if (
      !parent ||
      parent.streamId !== earlier.batch.streamId ||
      parent.sequence !== current.sequence - 1 ||
      parent.events.at(-1)!.revision >= current.events[0]!.revision ||
      parent.events.at(-1)!.at >= current.events[0]!.at
    )
      return "unproven";
    current = parent;
  }
  return context.bySequence.get(`${current.streamId}:${current.sequence}`)!
    .length === 1
    ? "linked_batches"
    : "unproven";
}
export function describeEvidenceTraceFact(
  context: Context,
  fact: EvidenceTraceFact,
) {
  const neighbors = context.neighbors.get(fact.rowId)!;
  const describeNeighbor = (
    neighbor: EvidenceTraceFact | null,
    previous: boolean,
  ) => {
    if (neighbor === null) return null;
    return {
      rowId: neighbor.rowId,
      batchId: neighbor.batch.id,
      eventId: neighbor.event.id,
      sequence: neighbor.batch.sequence,
      at: neighbor.event.at,
      transition: neighbor.event.transition,
      linkage: previous
        ? linkage(context, neighbor, fact)
        : linkage(context, fact, neighbor),
    };
  };
  const claims = context.receiptClaims.get(fact.batch.id) ?? [];
  const matching = claims.filter((claim) => claim.matchesBatch).length;
  const receiptProof =
    claims.length === 0
      ? "none"
      : matching !== claims.length
        ? "contradictory"
        : claims.length > 1 ||
            (context.sourceReceiptCounts.get(
              `${fact.batch.streamId}:${fact.batch.sequence}`,
            ) ?? 0) > 1
          ? "ambiguous"
          : "matching_signed_claim";
  const parent =
    fact.batch.previous === null ? null : context.byId.get(fact.batch.previous);
  const parentStatus =
    fact.batch.previous === null
      ? "genesis"
      : parent === undefined
        ? "missing"
        : parent!.streamId !== fact.batch.streamId ||
            parent!.sequence !== fact.batch.sequence - 1
          ? "mismatched"
          : "provided";
  const successors = context.children.get(fact.batch.id) ?? [];
  return {
    kind: "event" as const,
    rowId: fact.rowId,
    streamId: fact.batch.streamId,
    sequence: fact.batch.sequence,
    batchId: fact.batch.id,
    monitorFingerprint: fact.batch.monitorFingerprint,
    event: { ...fact.event },
    previous: describeNeighbor(neighbors.previous, true),
    next: describeNeighbor(neighbors.next, false),
    neighborScope: "nearest_provided_same_rule_not_complete_history",
    predecessor: { status: parentStatus, batchId: fact.batch.previous },
    providedSuccessors: successors.length,
    successorSamples: successors.slice(0, 4).map((batch) => batch.id),
    receiptProof,
    signedReceiptClaims: claims.slice(0, 4),
    receiptClaimsTruncated: claims.length > 4,
  };
}
