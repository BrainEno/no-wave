import {
  handoffHash,
  type HandoffBatch,
  type HandoffReceipt,
  type HandoffVerificationConfig,
} from "./alert-handoff-protocol.ts";

export type AlertEvidenceFaultCode =
  | "arguments_invalid"
  | "trust_invalid"
  | "manifest_invalid"
  | "requirements_invalid"
  | "artifact_invalid"
  | "integrity_mismatch"
  | "budget_exceeded"
  | "file_io"
  | "snapshot_changed"
  | "cursor_invalid"
  | "page_stale"
  | "clock_rollback"
  | "cancelled"
  | "output_failed";
export class AlertEvidenceFault extends Error {
  readonly code: AlertEvidenceFaultCode;
  constructor(code: AlertEvidenceFaultCode) {
    super(code);
    this.name = "AlertEvidenceFault";
    this.code = code;
  }
}
export const EVIDENCE_LIMITS = Object.freeze({
  artifacts: 256,
  artifactBytes: 256 * 1024,
  totalBytes: 8 * 1024 * 1024,
  events: 8192,
  trustBytes: 16 * 1024,
  manifestBytes: 128 * 1024,
  requirementsBytes: 32 * 1024,
  checkpoints: 64,
  findings: 128,
  defaultAgeMs: 86_400_000,
  maximumAgeMs: 30 * 86_400_000,
  outputBytes: 512 * 1024,
});
export type AlertEvidenceTrust = {
  profiles: readonly HandoffVerificationConfig[];
  byStream: ReadonlyMap<string, HandoffVerificationConfig>;
  receiverId: string;
  fingerprint: string;
};
export type EvidenceInput = { kind: "batch" | "receipt"; bytes: Buffer };
export type EvidenceOptions = { now: number; maxAgeMs?: number };
export type AuthenticatedEvidence = {
  batches: HandoffBatch[];
  receipts: HandoffReceipt[];
  artifactIds: string[];
  duplicates: number;
  events: number;
  totalBytes: number;
  evidenceId: string;
};
export const EVIDENCE_FINDING_CODES = [
  "source_not_provided",
  "history_prefix_missing",
  "sequence_gap",
  "sequence_fork",
  "predecessor_mismatch",
  "source_revision_rollback",
  "source_time_rollback",
  "preparation_time_rollback",
  "preparation_before_previous_acceptance",
  "monitor_configuration_changed",
  "event_replayed",
  "episode_origin_unproven",
  "episode_start_while_open",
  "episode_after_resolution",
  "episode_origin_changed",
  "episode_overlaps_resolution",
  "receipt_missing",
  "receipt_orphan",
  "receipt_equivocation",
  "receipt_batch_mismatch",
  "receipt_revision_impossible",
  "receipt_event_replayed",
  "receipt_sequence_rollback",
  "receipt_time_rollback",
  "inbox_revision_reused",
  "inbox_time_rollback",
  "evidence_stale",
  "batch_evidence_removed",
  "receipt_evidence_removed",
  "stream_tip_rollback",
  "stream_tip_replaced",
  "receiver_revision_rollback",
  "comparison_baseline_empty",
] as const;
export type EvidenceFindingCode = (typeof EVIDENCE_FINDING_CODES)[number];
export type EvidenceFinding = {
  code: EvidenceFindingCode;
  severity: "gap" | "conflict" | "warning";
  streamId: string | null;
  sequence: number | null;
  batchId: string | null;
  relatedId: string | null;
  eventId: string | null;
};
export type EvidenceScope = Partial<
  Pick<
    EvidenceFinding,
    "streamId" | "sequence" | "batchId" | "relatedId" | "eventId"
  >
>;

/** Count every distinct finding and expose a deterministic bounded summary.
 * All findings remain available for navigation within the admitted input bounds.
 * Input ordering cannot decide which conflict survives summary truncation. */
export class EvidenceFindings {
  private readonly seen = new Map<string, EvidenceFinding>();
  private readonly counts = new Map<EvidenceFindingCode, number>();
  private readonly samples: { key: string; value: EvidenceFinding }[] = [];
  private conflicts = 0;
  private gaps = 0;
  private warnings = 0;
  add(
    code: EvidenceFindingCode,
    severity: EvidenceFinding["severity"],
    scope: EvidenceScope = {},
  ): void {
    const value: EvidenceFinding = {
      code,
      severity,
      streamId: scope.streamId ?? null,
      sequence: scope.sequence ?? null,
      batchId: scope.batchId ?? null,
      relatedId: scope.relatedId ?? null,
      eventId: scope.eventId ?? null,
    };
    const key = JSON.stringify(value);
    if (this.seen.has(key)) return;
    this.seen.set(key, value);
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
    if (severity === "conflict") this.conflicts++;
    else if (severity === "gap") this.gaps++;
    else this.warnings++;
    let low = 0,
      high = this.samples.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.samples[middle]!.key < key) low = middle + 1;
      else high = middle;
    }
    if (low < EVIDENCE_LIMITS.findings) {
      this.samples.splice(low, 0, { key, value });
      if (this.samples.length > EVIDENCE_LIMITS.findings) this.samples.pop();
    }
  }
  all(): EvidenceFinding[] {
    return [...this.seen]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => ({ ...value }));
  }
  list(): EvidenceFinding[] {
    return this.samples.map(({ value }) => ({ ...value }));
  }
  summary() {
    return {
      total: this.seen.size,
      conflicts: this.conflicts,
      gaps: this.gaps,
      warnings: this.warnings,
      sampled: this.samples.length,
      truncated: this.seen.size > this.samples.length,
      byCode: [...this.counts]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([code, count]) => ({ code, count })),
    };
  }
}
export function evidenceOptions(options: EvidenceOptions): {
  now: number;
  maxAgeMs: number;
} {
  const maxAgeMs = options.maxAgeMs ?? EVIDENCE_LIMITS.defaultAgeMs;
  if (
    !Number.isSafeInteger(options.now) ||
    options.now < 0 ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1000 ||
    maxAgeMs > EVIDENCE_LIMITS.maximumAgeMs
  )
    throw new AlertEvidenceFault("arguments_invalid");
  return { now: options.now, maxAgeMs };
}
export function evidenceBatchScope(batch: HandoffBatch): EvidenceScope {
  return {
    streamId: batch.streamId,
    sequence: batch.sequence,
    batchId: batch.id,
  };
}
export function evidenceReceiptScope(receipt: HandoffReceipt): EvidenceScope {
  return {
    streamId: receipt.streamId,
    sequence: receipt.sequence,
    batchId: receipt.batchId,
  };
}
export function evidenceReceiptId(receipt: HandoffReceipt): string {
  return handoffHash(receipt);
}
export function evidenceBatchOrder(a: HandoffBatch, b: HandoffBatch): number {
  if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
  return a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function evidenceReceiptOrder(
  a: HandoffReceipt,
  b: HandoffReceipt,
): number {
  if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
  return (
    a.sequence - b.sequence ||
    a.inboxRevision - b.inboxRevision ||
    a.acceptedAt - b.acceptedAt ||
    evidenceReceiptId(a).localeCompare(evidenceReceiptId(b))
  );
}
