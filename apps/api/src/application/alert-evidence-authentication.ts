import {
  handoffHash,
  handoffJson,
  parseHandoffBatch,
  parseHandoffReceipt,
  type HandoffBatch,
  type HandoffReceipt,
} from "./alert-handoff-protocol.ts";
import {
  AlertEvidenceFault,
  EVIDENCE_LIMITS,
  evidenceBatchOrder,
  evidenceReceiptId,
  evidenceReceiptOrder,
  type AlertEvidenceTrust,
  type AuthenticatedEvidence,
  type EvidenceInput,
} from "./alert-evidence.ts";

/** Authenticate every input before any report is released. A malformed or
 * unpinned item invalidates the review, rather than becoming a partial success. */
export function authenticateAlertEvidence(
  trust: AlertEvidenceTrust,
  inputs: readonly EvidenceInput[],
  now: number,
): AuthenticatedEvidence {
  if (!Array.isArray(inputs) || inputs.length > EVIDENCE_LIMITS.artifacts)
    throw new AlertEvidenceFault("budget_exceeded");
  const batches = new Map<string, HandoffBatch>(),
    receipts = new Map<string, HandoffReceipt>();
  let totalBytes = 0,
    duplicates = 0,
    events = 0;
  for (const input of inputs) {
    if (
      !input ||
      !Buffer.isBuffer(input.bytes) ||
      !["batch", "receipt"].includes(input.kind)
    )
      throw new AlertEvidenceFault("artifact_invalid");
    if (
      input.bytes.length < 1 ||
      input.bytes.length > EVIDENCE_LIMITS.artifactBytes
    )
      throw new AlertEvidenceFault("budget_exceeded");
    totalBytes += input.bytes.length;
    if (totalBytes > EVIDENCE_LIMITS.totalBytes)
      throw new AlertEvidenceFault("budget_exceeded");
    try {
      const value = handoffJson(input.bytes, "artifact_invalid");
      if (
        !value ||
        typeof value !== "object" ||
        !("streamId" in value) ||
        typeof value.streamId !== "string"
      )
        throw new AlertEvidenceFault("artifact_invalid");
      const profile = trust.byStream.get(value.streamId);
      if (!profile) throw new AlertEvidenceFault("artifact_invalid");
      if (input.kind === "batch") {
        const batch = parseHandoffBatch(
          value,
          profile.senderKey,
          profile.streamId,
          profile.receiverId,
        );
        if (batch.preparedAt > now)
          throw new AlertEvidenceFault("clock_rollback");
        if (batches.has(batch.id)) {
          duplicates++;
          continue;
        }
        events += batch.events.length;
        if (events > EVIDENCE_LIMITS.events)
          throw new AlertEvidenceFault("budget_exceeded");
        batches.set(batch.id, batch);
      } else {
        const receipt = parseHandoffReceipt(value, profile.receiverKey);
        if (
          receipt.receiverId !== trust.receiverId ||
          receipt.streamId !== profile.streamId
        )
          throw new AlertEvidenceFault("artifact_invalid");
        if (receipt.acceptedAt > now)
          throw new AlertEvidenceFault("clock_rollback");
        const id = evidenceReceiptId(receipt);
        if (receipts.has(id)) duplicates++;
        else receipts.set(id, receipt);
      }
    } catch (error) {
      if (error instanceof AlertEvidenceFault) throw error;
      throw new AlertEvidenceFault("artifact_invalid");
    }
  }
  const artifactIds = [
    ...[...batches.keys()].map((id) => `batch:${id}`),
    ...[...receipts.keys()].map((id) => `receipt:${id}`),
  ].sort();
  return {
    batches: [...batches.values()].sort(evidenceBatchOrder),
    receipts: [...receipts.values()].sort(evidenceReceiptOrder),
    artifactIds,
    duplicates,
    events,
    totalBytes,
    evidenceId: handoffHash([
      "no-wave-alert-evidence-set-v1",
      trust.fingerprint,
      artifactIds,
    ]),
  };
}
