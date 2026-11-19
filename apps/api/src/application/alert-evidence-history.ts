import type { HandoffBatch } from "./alert-handoff-protocol.ts";
import {
  EvidenceFindings,
  evidenceBatchScope,
  type AlertEvidenceTrust,
  type AuthenticatedEvidence,
} from "./alert-evidence.ts";

export type EvidenceSegment = {
  boundary: "genesis" | "missing" | "fork" | "configuration";
  batches: HandoffBatch[];
};
export type EvidenceStreamHistory = {
  streamId: string;
  batches: HandoffBatch[];
  segments: EvidenceSegment[];
  firstSequence: number | null;
  lastSequence: number | null;
  missingSequences: number;
  forkedSequences: number;
  chainCoverage: "complete_from_sequence_one" | "partial" | "not_provided";
};

function inspectLink(
  current: HandoffBatch,
  prior: HandoffBatch,
  findings: EvidenceFindings,
): boolean {
  const scope = { ...evidenceBatchScope(current), relatedId: prior.id };
  let coherent = true;
  if (current.events[0]!.revision <= prior.events.at(-1)!.revision) {
    findings.add("source_revision_rollback", "conflict", scope);
    coherent = false;
  }
  if (current.events[0]!.at <= prior.events.at(-1)!.at) {
    findings.add("source_time_rollback", "conflict", scope);
    coherent = false;
  }
  if (current.preparedAt < prior.preparedAt) {
    findings.add("preparation_time_rollback", "conflict", scope);
    coherent = false;
  }
  if (current.monitorFingerprint !== prior.monitorFingerprint)
    findings.add("monitor_configuration_changed", "warning", scope);
  return coherent;
}

/** Sequence gaps are ranges, never expanded into attacker-sized loops. A
 * supplied fork remains evidence even when one of its branches has a receipt. */
export function reviewEvidenceHistory(
  trust: AlertEvidenceTrust,
  evidence: AuthenticatedEvidence,
  findings: EvidenceFindings,
): EvidenceStreamHistory[] {
  const allById = new Map(evidence.batches.map((batch) => [batch.id, batch]));
  const result: EvidenceStreamHistory[] = [];
  for (const profile of trust.profiles) {
    const streamId = profile.streamId;
    const batches = evidence.batches.filter(
      (batch) => batch.streamId === streamId,
    );
    if (batches.length === 0) {
      findings.add("source_not_provided", "gap", { streamId });
      result.push({
        streamId,
        batches,
        segments: [],
        firstSequence: null,
        lastSequence: null,
        missingSequences: 0,
        forkedSequences: 0,
        chainCoverage: "not_provided",
      });
      continue;
    }
    const groups = new Map<number, HandoffBatch[]>();
    for (const batch of batches) {
      const group = groups.get(batch.sequence) ?? [];
      group.push(batch);
      groups.set(batch.sequence, group);
    }
    const sequences = [...groups.keys()].sort((a, b) => a - b);
    const firstSequence = sequences[0]!,
      lastSequence = sequences.at(-1)!;
    let coherent = firstSequence === 1;
    let forkedSequences = 0;
    if (firstSequence !== 1)
      findings.add(
        "history_prefix_missing",
        "gap",
        evidenceBatchScope(batches[0]!),
      );
    const segments: EvidenceSegment[] = [];
    let segment: EvidenceSegment | null = null;
    let priorSequence = 0;
    let priorGroup: HandoffBatch[] = [];
    let nextBoundary: EvidenceSegment["boundary"] =
      firstSequence === 1 ? "genesis" : "missing";
    const seenEvents = new Map<string, string>();
    for (const sequence of sequences) {
      const group = groups.get(sequence)!;
      if (priorSequence !== 0 && sequence - priorSequence > 1) {
        findings.add("sequence_gap", "gap", {
          ...evidenceBatchScope(group[0]!),
          relatedId: priorGroup[0]!.id,
        });
        coherent = false;
        segment = null;
        nextBoundary = "missing";
      }
      if (group.length > 1) {
        forkedSequences++;
        coherent = false;
        segment = null;
        nextBoundary = "fork";
        for (const fork of group.slice(1))
          findings.add("sequence_fork", "conflict", {
            ...evidenceBatchScope(fork),
            relatedId: group[0]!.id,
          });
      }
      for (const batch of group) {
        const referenced =
          batch.previous === null ? undefined : allById.get(batch.previous);
        const immediatelyPrior =
          priorSequence !== 0 && sequence - priorSequence === 1;
        const expectedParent =
          referenced?.streamId === streamId &&
          referenced.sequence === sequence - 1;
        let connected = batch.sequence === 1;
        if (
          (referenced && !expectedParent) ||
          (immediatelyPrior &&
            !priorGroup.some((parent) => parent.id === batch.previous))
        ) {
          findings.add("predecessor_mismatch", "conflict", {
            ...evidenceBatchScope(batch),
            relatedId: batch.previous,
          });
          coherent = false;
          segment = null;
          nextBoundary = "missing";
        } else if (referenced && expectedParent) {
          connected = inspectLink(batch, referenced, findings);
          if (!connected) {
            coherent = false;
            segment = null;
            nextBoundary = "missing";
          } else if (
            batch.monitorFingerprint !== referenced.monitorFingerprint
          ) {
            segment = null;
            nextBoundary = "configuration";
          }
        }
        for (const event of batch.events) {
          const previousBatchId = seenEvents.get(event.id);
          if (previousBatchId !== undefined) {
            findings.add("event_replayed", "conflict", {
              ...evidenceBatchScope(batch),
              relatedId: previousBatchId,
              eventId: event.id,
            });
            coherent = false;
          } else seenEvents.set(event.id, batch.id);
        }
        if (group.length === 1) {
          if (!connected && batch.sequence !== 1) segment = null;
          if (segment === null) {
            segment = { boundary: nextBoundary, batches: [] };
            segments.push(segment);
          }
          segment.batches.push(batch);
        }
      }
      if (group.length > 1) segment = null;
      priorSequence = sequence;
      priorGroup = group;
    }
    result.push({
      streamId,
      batches,
      segments,
      firstSequence,
      lastSequence,
      missingSequences: lastSequence - groups.size,
      forkedSequences,
      chainCoverage: coherent ? "complete_from_sequence_one" : "partial",
    });
  }
  return result;
}
