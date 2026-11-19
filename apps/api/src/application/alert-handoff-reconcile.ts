import { parseMonitorState } from "./operational-monitor-state.ts";
import type { MonitorConfig } from "./operational-monitor.ts";
import { parseHandoffInboxState } from "./alert-handoff-inbox.ts";
import {
  assertHandoffMonitorPrefix,
  parseHandoffSenderState,
} from "./alert-handoff-sender.ts";
import {
  HandoffFault,
  verifyHandoffReceipt,
  type HandoffInboxConfig,
  type HandoffSenderConfig,
} from "./alert-handoff-protocol.ts";

type Stage =
  | "sender_not_observed"
  | "receiver_not_observed"
  | "peer_mismatch"
  | "evidence_invalid"
  | "clock_invalid"
  | "receiver_ahead"
  | "receiver_rollback"
  | "batch_fork"
  | "receipt_conflict"
  | "source_prefix_changed"
  | "awaiting_receive"
  | "received_awaiting_settlement"
  | "receipt_recorded_awaiting_ack"
  | "source_acknowledged_awaiting_finalize"
  | "unprepared_events"
  | "settled_pending_consumption"
  | "settled"
  | "idle";
export type HandoffReconciliation = {
  version: 1;
  event: "alert_handoff_reconcile";
  scope: "non_atomic_offline_evidence";
  reportedAt: number;
  stage: Stage;
  exitCode: 0 | 1 | 3;
  findings: Stage[];
  source: {
    senderRevision: number;
    monitorRevision: number;
    sequence: number;
    pendingEvents: number;
    preparedEvents: number;
  } | null;
  inbox: {
    revision: number;
    sequence: number;
    pending: number;
    streamPending: number;
  } | null;
  receipt: {
    batchId: string;
    sequence: number;
    acceptedAt: number;
    pendingEntries: number;
    evidence: "durable_acceptance_only";
  } | null;
};

/** Cross-file reconciliation reports a conservative evidence comparison, never
 * a distributed snapshot, delivery SLA, human acknowledgement or repair plan.
 * A mismatch is explicit; no lock, clock, receipt or event is advanced here. */
export function reconcileAlertHandoff(input: {
  senderConfig: HandoffSenderConfig;
  senderState: unknown | null;
  sourceBinding: string;
  inboxConfig: HandoffInboxConfig;
  inboxState: unknown | null;
  monitorConfig: MonitorConfig;
  monitorState: unknown;
  now: number;
}): HandoffReconciliation {
  const report: HandoffReconciliation = {
    version: 1,
    event: "alert_handoff_reconcile",
    scope: "non_atomic_offline_evidence",
    reportedAt:
      Number.isSafeInteger(input.now) && input.now >= 0 ? input.now : 0,
    stage: "evidence_invalid",
    exitCode: 3,
    findings: [],
    source: null,
    inbox: null,
    receipt: null,
  };
  const finish = (stage: Stage, exitCode: 0 | 1 | 3): HandoffReconciliation => {
    report.stage = stage;
    report.exitCode = exitCode;
    if (exitCode !== 0) report.findings.push(stage);
    return report;
  };
  try {
    const { senderConfig: sender, inboxConfig: receiver } = input;
    const source = receiver.sources.find(
      (source) => source.streamId === sender.streamId,
    );
    if (
      !source ||
      sender.receiverId !== receiver.receiverId ||
      !source.publicKey
        .export({ format: "der", type: "spki" })
        .equals(sender.publicKey.export({ format: "der", type: "spki" })) ||
      !sender.receiverKey
        .export({ format: "der", type: "spki" })
        .equals(receiver.publicKey.export({ format: "der", type: "spki" }))
    )
      return finish("peer_mismatch", 3);
    if (input.senderState === null) return finish("sender_not_observed", 3);
    const state = parseHandoffSenderState(
      input.senderState,
      sender,
      input.sourceBinding,
    );
    const monitor = parseMonitorState(input.monitorState, input.monitorConfig);
    report.source = {
      senderRevision: state.revision,
      monitorRevision: monitor.revision,
      sequence: state.sequence,
      pendingEvents: monitor.events.length,
      preparedEvents: state.pending?.batch.events.length ?? 0,
    };
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      input.now < (state.lastPreparedAt ?? 0) ||
      input.now < (monitor.lastEvaluatedAt ?? 0) ||
      input.now < (monitor.lastConfigurationChange?.at ?? 0) ||
      input.now < (state.lastReceipt?.acceptedAt ?? 0) ||
      input.now < (state.pending?.receipt?.acceptedAt ?? 0)
    )
      return finish("clock_invalid", 3);
    if (input.inboxState === null) return finish("receiver_not_observed", 3);
    const inbox = parseHandoffInboxState(input.inboxState, receiver);
    if (input.now < (inbox.lastMutationAt ?? 0))
      return finish("clock_invalid", 3);
    const cursor = inbox.cursors.find(
      (cursor) => cursor.streamId === sender.streamId,
    )!;
    report.inbox = {
      revision: inbox.revision,
      sequence: cursor.sequence,
      pending: inbox.entries.length,
      streamPending: inbox.entries.filter(
        (entry) => entry.streamId === sender.streamId,
      ).length,
    };
    const expectedSequence = state.pending?.batch.sequence ?? state.sequence;
    if (cursor.sequence > expectedSequence) return finish("receiver_ahead", 3);
    if (cursor.sequence < state.sequence) return finish("receiver_rollback", 3);
    if (
      cursor.sequence === state.sequence &&
      cursor.batchId !== state.lastBatchId
    )
      return finish("batch_fork", 3);
    if (state.pending !== null) {
      const batch = state.pending.batch;
      if (cursor.sequence === batch.sequence && cursor.batchId !== batch.id)
        return finish("batch_fork", 3);
      let remainingPrefix: number;
      try {
        remainingPrefix = assertHandoffMonitorPrefix(batch, monitor);
      } catch (error) {
        if (
          error instanceof HandoffFault &&
          error.code === "monitor_prefix_changed"
        )
          return finish("source_prefix_changed", 3);
        throw error;
      }
      if (cursor.sequence === state.sequence) {
        // A recorded receipt newer than the receiver snapshot is rollback or
        // non-atomic evidence, not permission to silently replay the source.
        if (state.pending.receipt !== null)
          return finish("receiver_rollback", 3);
        return finish("awaiting_receive", 1);
      }
      if (cursor.sequence !== batch.sequence || cursor.receipt === null)
        return finish("evidence_invalid", 3);
      const receipt = verifyHandoffReceipt(cursor.receipt, sender, batch);
      if (
        state.pending.receipt !== null &&
        JSON.stringify(state.pending.receipt) !== JSON.stringify(receipt)
      )
        return finish("receipt_conflict", 3);
      const entries = inbox.entries.filter(
        (entry) =>
          entry.streamId === sender.streamId && entry.batchId === batch.id,
      );
      const suffix = batch.events.slice(batch.events.length - entries.length);
      if (
        entries.length > batch.events.length ||
        entries.some(
          (entry, index) =>
            entry.monitorFingerprint !== batch.monitorFingerprint ||
            JSON.stringify(entry.event) !== JSON.stringify(suffix[index]),
        )
      )
        return finish("receipt_conflict", 3);
      report.receipt = {
        batchId: receipt.batchId,
        sequence: receipt.sequence,
        acceptedAt: receipt.acceptedAt,
        pendingEntries: entries.length,
        evidence: "durable_acceptance_only",
      };
      if (remainingPrefix === 0)
        return finish("source_acknowledged_awaiting_finalize", 1);
      return finish(
        state.pending.receipt === null
          ? "received_awaiting_settlement"
          : "receipt_recorded_awaiting_ack",
        1,
      );
    }
    if (state.sequence > 0) {
      if (
        !cursor.receipt ||
        JSON.stringify(cursor.receipt) !== JSON.stringify(state.lastReceipt)
      )
        return finish("receipt_conflict", 3);
      report.receipt = {
        batchId: cursor.receipt.batchId,
        sequence: cursor.sequence,
        acceptedAt: cursor.receipt.acceptedAt,
        pendingEntries: inbox.entries.filter(
          (entry) =>
            entry.streamId === sender.streamId &&
            entry.batchId === cursor.batchId,
        ).length,
        evidence: "durable_acceptance_only",
      };
    }
    if (monitor.events.length > 0) return finish("unprepared_events", 1);
    if (inbox.entries.length > 0)
      return finish("settled_pending_consumption", 1);
    return finish(state.sequence === 0 ? "idle" : "settled", 0);
  } catch {
    return finish("evidence_invalid", 3);
  }
}
