import type { MonitorState } from "./operational-monitor.ts";
import {
  HandoffFault,
  createHandoffBatch,
  handoffDigest,
  handoffFields,
  handoffInteger,
  parseHandoffBatch,
  parseHandoffReceipt,
  verifyHandoffReceipt,
  type HandoffBatch,
  type HandoffReceipt,
  type HandoffSenderConfig,
} from "./alert-handoff-protocol.ts";

export type HandoffSenderState = {
  version: 1;
  kind: "alert_sender";
  fingerprint: string;
  sourceBinding: string;
  revision: number;
  sequence: number;
  lastBatchId: string | null;
  lastPreparedAt: number | null;
  lastReceipt: HandoffReceipt | null;
  pending: { batch: HandoffBatch; receipt: HandoffReceipt | null } | null;
};
function invalid(): never {
  throw new HandoffFault("state_invalid");
}
function empty(
  config: HandoffSenderConfig,
  sourceBinding: string,
): HandoffSenderState {
  return {
    version: 1,
    kind: "alert_sender",
    fingerprint: config.fingerprint,
    sourceBinding,
    revision: 0,
    sequence: 0,
    lastBatchId: null,
    lastPreparedAt: null,
    lastReceipt: null,
    pending: null,
  };
}
export function parseHandoffSenderState(
  value: unknown,
  config: HandoffSenderConfig,
  sourceBinding: string,
): HandoffSenderState {
  const row = handoffFields(
    value,
    [
      "version",
      "kind",
      "fingerprint",
      "sourceBinding",
      "revision",
      "sequence",
      "lastBatchId",
      "lastPreparedAt",
      "lastReceipt",
      "pending",
    ],
    "state_invalid",
  );
  if (row.version !== 1 || row.kind !== "alert_sender") invalid();
  if (handoffDigest(row.fingerprint) !== config.fingerprint)
    throw new HandoffFault("state_config_mismatch");
  if (handoffDigest(row.sourceBinding) !== handoffDigest(sourceBinding))
    throw new HandoffFault("state_binding_mismatch");
  const revision = handoffInteger(row.revision),
    sequence = handoffInteger(row.sequence);
  const lastBatchId =
    row.lastBatchId === null ? null : handoffDigest(row.lastBatchId);
  const lastPreparedAt =
    row.lastPreparedAt === null ? null : handoffInteger(row.lastPreparedAt);
  let lastReceipt: HandoffReceipt | null = null;
  let pending: HandoffSenderState["pending"] = null;
  try {
    if (row.lastReceipt !== null) {
      lastReceipt = parseHandoffReceipt(row.lastReceipt, config.receiverKey);
      if (
        lastReceipt.streamId !== config.streamId ||
        lastReceipt.receiverId !== config.receiverId ||
        lastReceipt.sequence !== sequence ||
        lastReceipt.batchId !== lastBatchId
      )
        invalid();
    }
    if (row.pending !== null) {
      const intent = handoffFields(
        row.pending,
        ["batch", "receipt"],
        "state_invalid",
      );
      const batch = parseHandoffBatch(
        intent.batch,
        config.publicKey,
        config.streamId,
        config.receiverId,
      );
      if (
        batch.sequence !== sequence + 1 ||
        batch.previous !== lastBatchId ||
        batch.preparedAt !== lastPreparedAt
      )
        invalid();
      const receipt =
        intent.receipt === null
          ? null
          : verifyHandoffReceipt(intent.receipt, config, batch);
      pending = { batch, receipt };
    }
  } catch {
    invalid();
  }
  if (
    (sequence === 0) !== (lastBatchId === null) ||
    (sequence === 0) !== (lastReceipt === null)
  )
    invalid();
  if (
    (revision === 0) !== (lastPreparedAt === null) ||
    (revision === 0 && (pending !== null || sequence !== 0))
  )
    invalid();
  if (revision > 0 && pending === null && sequence === 0) invalid();
  // Each settled sequence required prepare, receipt intent and final commit.
  const minimumRevision =
    sequence * 3 + (pending === null ? 0 : pending.receipt === null ? 1 : 2);
  if (!Number.isSafeInteger(minimumRevision) || revision !== minimumRevision)
    invalid();
  return {
    version: 1,
    kind: "alert_sender",
    fingerprint: config.fingerprint,
    sourceBinding,
    revision,
    sequence,
    lastBatchId,
    lastPreparedAt,
    lastReceipt,
    pending,
  };
}

/** Check the entire prepared prefix, not merely its terminal ID. New monitor
 * events may append while the offline batch is in transit. Manual advancement
 * past this prefix is ambiguous and must never acknowledge the newer tail. */
export function assertHandoffMonitorPrefix(
  batch: HandoffBatch,
  monitor: MonitorState,
): number {
  if (monitor.fingerprint !== batch.monitorFingerprint)
    throw new HandoffFault("monitor_prefix_changed");
  const latest = batch.events.at(-1)!;
  if (
    monitor.revision < latest.revision ||
    (monitor.lastEvaluatedAt ?? -1) < latest.at
  )
    throw new HandoffFault("monitor_prefix_changed");
  const ids = new Set(batch.events.map((event) => event.id));
  if (
    monitor.acknowledgedThrough === latest.id &&
    !monitor.events.some((event) => ids.has(event.id))
  ) {
    if (monitor.revision === latest.revision)
      throw new HandoffFault("monitor_prefix_changed");
    return 0;
  }
  if (
    monitor.events.length < batch.events.length ||
    batch.events.some(
      (event, index) =>
        JSON.stringify(event) !== JSON.stringify(monitor.events[index]),
    )
  )
    throw new HandoffFault("monitor_prefix_changed");
  return batch.events.length;
}
export function prepareAlertHandoff(
  config: HandoffSenderConfig,
  previous: unknown | null,
  monitor: MonitorState,
  sourceBinding: string,
  now: number,
): { state: HandoffSenderState | null; batch: HandoffBatch | null } {
  const state =
    previous === null
      ? empty(config, handoffDigest(sourceBinding))
      : parseHandoffSenderState(previous, config, sourceBinding);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now < (monitor.lastEvaluatedAt ?? 0) ||
    now < (state.lastPreparedAt ?? 0)
  )
    throw new HandoffFault("clock_rollback");
  if (state.pending) {
    assertHandoffMonitorPrefix(state.pending.batch, monitor);
    return { state, batch: state.pending.batch };
  }
  if (monitor.events.length === 0)
    return { state: previous === null ? null : state, batch: null };
  if (
    state.revision >= Number.MAX_SAFE_INTEGER - 3 ||
    state.sequence >= Number.MAX_SAFE_INTEGER
  )
    throw new HandoffFault("state_full");
  // Whole monitor queue, never half an evaluation revision. This permits a
  // constant-size per-stream replay cursor on the receiving side.
  const batch = createHandoffBatch(
    config,
    monitor.events,
    monitor.fingerprint,
    state.sequence + 1,
    state.lastBatchId,
    now,
  );
  state.revision++;
  state.lastPreparedAt = now;
  state.pending = { batch, receipt: null };
  return {
    state: parseHandoffSenderState(state, config, sourceBinding),
    batch,
  };
}

/** Separate durable receipt intent from source acknowledgement. If either
 * process dies, retrying the same receipt resumes from an unambiguous stage.
 * The caller owns sender serialization and the monitor's own lock/transaction. */
export async function settleAlertHandoff(
  config: HandoffSenderConfig,
  previous: unknown,
  receiptValue: unknown,
  ports: {
    persist: (state: HandoffSenderState) => void | Promise<void>;
    acknowledge: (batch: HandoffBatch) => number | Promise<number>;
  },
): Promise<{
  state: HandoffSenderState;
  acknowledged: number;
  duplicate: boolean;
}> {
  const binding = handoffFields(
    previous,
    [
      "version",
      "kind",
      "fingerprint",
      "sourceBinding",
      "revision",
      "sequence",
      "lastBatchId",
      "lastPreparedAt",
      "lastReceipt",
      "pending",
    ],
    "state_invalid",
  ).sourceBinding;
  let state = parseHandoffSenderState(previous, config, handoffDigest(binding));
  if (state.pending === null) {
    const receipt = parseHandoffReceipt(receiptValue, config.receiverKey);
    if (
      !state.lastReceipt ||
      JSON.stringify(receipt) !== JSON.stringify(state.lastReceipt)
    )
      throw new HandoffFault("artifact_invalid");
    return { state, acknowledged: 0, duplicate: true };
  }
  const receipt = verifyHandoffReceipt(
    receiptValue,
    config,
    state.pending.batch,
  );
  if (state.pending.receipt === null) {
    state.pending.receipt = receipt;
    state.revision++;
    state = parseHandoffSenderState(state, config, state.sourceBinding);
    await ports.persist(state);
  } else if (JSON.stringify(receipt) !== JSON.stringify(state.pending.receipt))
    throw new HandoffFault("artifact_invalid");
  const batch = state.pending!.batch;
  const acknowledged = await ports.acknowledge(batch);
  if (acknowledged !== 0 && acknowledged !== batch.events.length)
    throw new HandoffFault("monitor_prefix_changed");
  // Persistence ports may retain the submitted snapshot. Never mutate that
  // durable receipt intent while preparing the subsequent final commit.
  state = parseHandoffSenderState(state, config, state.sourceBinding);
  state.sequence = batch.sequence;
  state.lastBatchId = batch.id;
  state.lastReceipt = receipt;
  state.pending = null;
  state.revision++;
  state = parseHandoffSenderState(state, config, state.sourceBinding);
  await ports.persist(state);
  return { state, acknowledged, duplicate: false };
}
