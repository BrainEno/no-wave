import type { MonitorState } from "./operational-monitor.ts";
import { parseHandoffInboxState } from "./alert-handoff-inbox.ts";
import {
  assertHandoffMonitorPrefix,
  parseHandoffSenderState,
} from "./alert-handoff-sender.ts";
import {
  HandoffFault,
  type HandoffInboxConfig,
  type HandoffSenderConfig,
} from "./alert-handoff-protocol.ts";

export const HANDOFF_DEFAULT_PENDING_BUDGET_MS = 3_600_000;
function validateBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 86_400_000)
    throw new HandoffFault("arguments_invalid");
}
function validateClock(now: number, minimum: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now < minimum)
    throw new HandoffFault("clock_rollback");
}
function ageClass(
  age: number | null,
  budget: number,
): "none" | "within_budget" | "overdue" {
  return age === null ? "none" : age >= budget ? "overdue" : "within_budget";
}
export function alertSenderStatus(
  config: HandoffSenderConfig,
  value: unknown,
  binding: string,
  monitor: MonitorState,
  now: number,
  maxPendingAgeMs = HANDOFF_DEFAULT_PENDING_BUDGET_MS,
) {
  validateBudget(maxPendingAgeMs);
  const state = parseHandoffSenderState(value, config, binding);
  validateClock(
    now,
    Math.max(
      state.lastPreparedAt ?? 0,
      monitor.lastEvaluatedAt ?? 0,
      monitor.lastConfigurationChange?.at ?? 0,
      state.lastReceipt?.acceptedAt ?? 0,
      state.pending?.receipt?.acceptedAt ?? 0,
    ),
  );
  const remainingPrefix = state.pending
    ? assertHandoffMonitorPrefix(state.pending.batch, monitor)
    : 0;
  const unprepared = state.pending === null && monitor.events.length > 0;
  const phase =
    state.pending === null
      ? unprepared
        ? "not_prepared"
        : "idle"
      : state.pending.receipt === null
        ? "awaiting_receipt"
        : "awaiting_ack";
  const waitingSince =
    state.pending?.batch.preparedAt ??
    (unprepared ? monitor.events[0]!.at : null);
  const pendingAgeMs = waitingSince === null ? null : now - waitingSince;
  return {
    version: 1,
    event: "alert_sender_status",
    scope: "handoff_progress_only",
    reportedAt: now,
    revision: state.revision,
    phase,
    sequence: state.sequence,
    pendingBatchId: state.pending?.batch.id ?? null,
    preparedEvents: state.pending?.batch.events.length ?? 0,
    remainingPrefix,
    monitorPending: monitor.events.length,
    lastReceiptBatchId: state.lastReceipt?.batchId ?? null,
    waitingSince,
    pendingAgeMs,
    age: ageClass(pendingAgeMs, maxPendingAgeMs),
    maxPendingAgeMs,
    exitCode: state.pending !== null || unprepared ? 1 : 0,
  };
}
export function alertInboxStatus(
  config: HandoffInboxConfig,
  value: unknown,
  now: number,
  maxPendingAgeMs = HANDOFF_DEFAULT_PENDING_BUDGET_MS,
) {
  validateBudget(maxPendingAgeMs);
  const state = parseHandoffInboxState(value, config);
  validateClock(now, state.lastMutationAt ?? 0);
  const first = state.entries[0];
  const oldestAcceptedAt = first?.acceptedAt ?? null;
  const oldestAcceptanceAgeMs =
    oldestAcceptedAt === null ? null : now - oldestAcceptedAt;
  // Different sources' event clocks need not be ordered by inbox ordinal.
  const oldestEventAt =
    state.entries.length === 0
      ? null
      : Math.min(...state.entries.map((entry) => entry.event.at));
  const oldestEventAgeMs = oldestEventAt === null ? null : now - oldestEventAt;
  const sources = state.cursors.map((cursor) => {
    const entries = state.entries.filter(
      (entry) => entry.streamId === cursor.streamId,
    );
    const oldestAt = entries[0]?.acceptedAt ?? null;
    const pendingAgeMs = oldestAt === null ? null : now - oldestAt;
    return {
      streamId: cursor.streamId,
      sequence: cursor.sequence,
      lastAcceptedAt: cursor.receipt?.acceptedAt ?? null,
      pending: entries.length,
      oldestAcceptedAt: oldestAt,
      pendingAgeMs,
      age: ageClass(pendingAgeMs, maxPendingAgeMs),
    };
  });
  return {
    version: 1,
    event: "alert_inbox_status",
    scope: "handoff_progress_only",
    reportedAt: now,
    revision: state.revision,
    lastMutationAt: state.lastMutationAt,
    pending: state.entries.length,
    consumedThrough: state.consumedThrough?.id ?? null,
    oldestAcceptedAt,
    oldestAcceptanceAgeMs,
    oldestEventAt,
    oldestEventAgeMs,
    age: ageClass(oldestAcceptanceAgeMs, maxPendingAgeMs),
    maxPendingAgeMs,
    sources,
    exitCode: state.entries.length > 0 ? 1 : 0,
  };
}
