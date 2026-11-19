import {
  HANDOFF_HASH,
  handoffFields,
  handoffHash,
  verifyHandoffReceipt,
  type HandoffBatch,
  type HandoffReceipt,
} from "./alert-handoff-protocol.ts";
import { analyzeAlertEvidence } from "./alert-evidence-review.ts";
import {
  AlertEvidenceFault,
  EVIDENCE_LIMITS,
  evidenceReceiptId,
  type AlertEvidenceTrust,
  type EvidenceInput,
  type EvidenceOptions,
} from "./alert-evidence.ts";

type Checkpoint = {
  streamId: string;
  sequence: number;
  batchId: string;
  receiptId: string | null;
  coverage: "point" | "prefix";
};
export type EvidenceRequirements = {
  version: 1;
  role: "evidence-requirements";
  trustFingerprint: string;
  checkpoints: Checkpoint[];
};
type CheckpointFailure =
  | "checkpoint_missing"
  | "checkpoint_identity_mismatch"
  | "checkpoint_forked"
  | "receipt_missing"
  | "receipt_mismatch"
  | "receipt_equivocation"
  | "prefix_missing"
  | "prefix_forked"
  | "prefix_link_mismatch";

/** Requirements are independently supplied operator expectations, not facts
 * authenticated by their own hashes or by the untrusted evidence manifest. */
export function parseEvidenceRequirements(
  value: unknown,
  trust: AlertEvidenceTrust,
): EvidenceRequirements {
  try {
    const row = handoffFields(
      value,
      ["version", "role", "trustFingerprint", "checkpoints"],
      "artifact_invalid",
    );
    if (
      row.version !== 1 ||
      row.role !== "evidence-requirements" ||
      row.trustFingerprint !== trust.fingerprint ||
      !Array.isArray(row.checkpoints) ||
      row.checkpoints.length === 0
    )
      throw new AlertEvidenceFault("requirements_invalid");
    if (row.checkpoints.length > EVIDENCE_LIMITS.checkpoints)
      throw new AlertEvidenceFault("budget_exceeded");
    const checkpoints: Checkpoint[] = [];
    const identities = new Set<string>(),
      batches = new Set<string>();
    for (const value of row.checkpoints) {
      const item = handoffFields(
        value,
        ["streamId", "sequence", "batchId", "receiptId", "coverage"],
        "artifact_invalid",
      );
      if (
        typeof item.streamId !== "string" ||
        !trust.byStream.has(item.streamId) ||
        typeof item.sequence !== "number" ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 1 ||
        typeof item.batchId !== "string" ||
        !HANDOFF_HASH.test(item.batchId) ||
        (item.receiptId !== null &&
          (typeof item.receiptId !== "string" ||
            !HANDOFF_HASH.test(item.receiptId))) ||
        (item.coverage !== "point" && item.coverage !== "prefix")
      )
        throw new AlertEvidenceFault("requirements_invalid");
      const identity = `${item.streamId}:${item.sequence}`;
      if (identities.has(identity) || batches.has(item.batchId))
        throw new AlertEvidenceFault("requirements_invalid");
      identities.add(identity);
      batches.add(item.batchId);
      checkpoints.push({
        streamId: item.streamId,
        sequence: item.sequence,
        batchId: item.batchId,
        receiptId: item.receiptId,
        coverage: item.coverage,
      });
    }
    checkpoints.sort((a, b) =>
      a.streamId < b.streamId
        ? -1
        : a.streamId > b.streamId
          ? 1
          : a.sequence - b.sequence,
    );
    return {
      version: 1,
      role: "evidence-requirements",
      trustFingerprint: trust.fingerprint,
      checkpoints,
    };
  } catch (error) {
    if (error instanceof AlertEvidenceFault) throw error;
    throw new AlertEvidenceFault("requirements_invalid");
  }
}

/** Walk signed predecessor IDs, never loop from one to an untrusted numeric
 * sequence. A missing ancestor or an authentic alternative is not filled in. */
function inspectPrefix(
  anchor: HandoffBatch,
  batches: ReadonlyMap<string, HandoffBatch>,
  sequences: ReadonlyMap<string, HandoffBatch[]>,
  failures: Set<CheckpointFailure>,
) {
  const seen = new Set<string>();
  const chain: HandoffBatch[] = [];
  let current: HandoffBatch | undefined = anchor;
  while (current) {
    if (seen.has(current.id) || chain.length >= EVIDENCE_LIMITS.artifacts) {
      failures.add("prefix_link_mismatch");
      break;
    }
    seen.add(current.id);
    chain.push(current);
    const alternatives = sequences.get(
      `${current.streamId}:${current.sequence}`,
    )!;
    if (alternatives.length !== 1) failures.add("prefix_forked");
    if (current.sequence === 1) break;
    const parent = batches.get(current.previous!);
    if (!parent) {
      failures.add("prefix_missing");
      break;
    }
    if (
      parent.streamId !== anchor.streamId ||
      parent.sequence !== current.sequence - 1
    ) {
      failures.add("prefix_link_mismatch");
      break;
    }
    current = parent;
  }
  chain.reverse();
  const first = chain[0]!;
  const covered =
    first.sequence === 1 &&
    !failures.has("prefix_missing") &&
    !failures.has("prefix_link_mismatch") &&
    !failures.has("prefix_forked");
  const ids = chain.map((batch) => batch.id);
  let events = 0;
  for (const batch of chain) events += batch.events.length;
  return {
    covered,
    batches: chain.length,
    events,
    tipEvents: anchor.events.length,
    firstSequence: first.sequence,
    lastSequence: anchor.sequence,
    firstBatchId: first.id,
    lastBatchId: anchor.id,
    chainDigest: handoffHash(["no-wave-alert-evidence-prefix-v1", ids]),
    batchSamples:
      ids.length <= 8 ? ids : [...ids.slice(0, 4), ...ids.slice(-4)],
    samplesTruncated: ids.length > 8,
  };
}
function inspectReceipt(
  expected: Checkpoint,
  batch: HandoffBatch,
  receipts: ReadonlyMap<string, HandoffReceipt>,
  sameSequence: readonly HandoffReceipt[],
  trust: AlertEvidenceTrust,
  failures: Set<CheckpointFailure>,
) {
  if (expected.receiptId === null) return "not_required" as const;
  const receipt = receipts.get(expected.receiptId);
  if (!receipt) {
    failures.add("receipt_missing");
    return "missing" as const;
  }
  try {
    verifyHandoffReceipt(
      receipt,
      trust.byStream.get(expected.streamId)!,
      batch,
    );
  } catch {
    failures.add("receipt_mismatch");
    return "mismatch" as const;
  }
  if (sameSequence.length !== 1) {
    failures.add("receipt_equivocation");
    return "ambiguous" as const;
  }
  return "matched" as const;
}

export function checkAlertEvidenceRequirements(
  trust: AlertEvidenceTrust,
  inputs: readonly EvidenceInput[],
  requirementsValue: unknown,
  options: EvidenceOptions,
) {
  const requirements = parseEvidenceRequirements(requirementsValue, trust);
  const { evidence, report } = analyzeAlertEvidence(trust, inputs, options);
  const byId = new Map(evidence.batches.map((batch) => [batch.id, batch]));
  const sequences = new Map<string, HandoffBatch[]>();
  const receiptSequences = new Map<string, HandoffReceipt[]>();
  for (const batch of evidence.batches) {
    const key = `${batch.streamId}:${batch.sequence}`;
    const group = sequences.get(key) ?? [];
    group.push(batch);
    sequences.set(key, group);
  }
  const receipts = new Map<string, HandoffReceipt>();
  for (const receipt of evidence.receipts) {
    receipts.set(evidenceReceiptId(receipt), receipt);
    const key = `${receipt.streamId}:${receipt.sequence}`;
    const group = receiptSequences.get(key) ?? [];
    group.push(receipt);
    receiptSequences.set(key, group);
  }
  const checkpoints = requirements.checkpoints.map((expected) => {
    const failures = new Set<CheckpointFailure>();
    const batch = byId.get(expected.batchId);
    let prefix: ReturnType<typeof inspectPrefix> | null = null;
    let receipt: ReturnType<typeof inspectReceipt> =
      expected.receiptId === null ? "not_required" : "missing";
    if (!batch) failures.add("checkpoint_missing");
    else if (
      batch.streamId !== expected.streamId ||
      batch.sequence !== expected.sequence
    )
      failures.add("checkpoint_identity_mismatch");
    else {
      const key = `${expected.streamId}:${expected.sequence}`;
      if (sequences.get(key)!.length !== 1) failures.add("checkpoint_forked");
      receipt = inspectReceipt(
        expected,
        batch,
        receipts,
        receiptSequences.get(key) ?? [],
        trust,
        failures,
      );
      if (expected.coverage === "prefix")
        prefix = inspectPrefix(batch, byId, sequences, failures);
    }
    return {
      streamId: expected.streamId,
      sequence: expected.sequence,
      batchId: expected.batchId,
      coverage: expected.coverage,
      receipt,
      prefix,
      matched: failures.size === 0,
      failures: [...failures].sort(),
    };
  });
  const requirementsSatisfied = checkpoints.every(
    (checkpoint) => checkpoint.matched,
  );
  return {
    version: 1,
    event: "alert_evidence_requirements",
    evidence: "signed_history_only",
    requirementsProvenance: "operator_supplied_not_self_authenticated",
    tailFinality: "not_proven",
    requirementsId: handoffHash(requirements),
    requirementsSatisfied,
    checkpoints,
    report,
    exitCode: (!requirementsSatisfied || report.exitCode !== 0 ? 1 : 0) as
      0 | 1,
  };
}
