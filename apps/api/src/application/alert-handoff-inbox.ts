import type { MonitorEvent } from "./operational-monitor.ts";
import { parseMonitorEvent } from "./operational-monitor-state.ts";
import {
  HandoffFault,
  createHandoffReceipt,
  handoffDigest,
  handoffFields,
  handoffHash,
  handoffInteger,
  parseHandoffReceipt,
  verifyHandoffBatch,
  type HandoffInboxConfig,
  type HandoffReceipt,
} from "./alert-handoff-protocol.ts";

export const ALERT_INBOX_LIMIT = 1024;
export type AlertInboxEntry = {
  id: string;
  ordinal: number;
  streamId: string;
  sequence: number;
  batchId: string;
  monitorFingerprint: string;
  acceptedAt: number;
  inboxRevision: number;
  event: MonitorEvent;
};
type Cursor = {
  streamId: string;
  sequence: number;
  batchId: string | null;
  lastEventRevision: number | null;
  lastEventAt: number | null;
  receipt: HandoffReceipt | null;
};
export type HandoffInboxState = {
  version: 1;
  kind: "alert_inbox";
  fingerprint: string;
  revision: number;
  lastMutationAt: number | null;
  nextOrdinal: number;
  consumedThrough: { id: string; ordinal: number } | null;
  cursors: Cursor[];
  entries: AlertInboxEntry[];
};
function invalid(): never {
  throw new HandoffFault("state_invalid");
}
function entryId(
  receiver: string,
  ordinal: number,
  stream: string,
  sequence: number,
  batch: string,
  event: string,
): string {
  return handoffHash([receiver, ordinal, stream, sequence, batch, event]);
}
function empty(config: HandoffInboxConfig): HandoffInboxState {
  return {
    version: 1,
    kind: "alert_inbox",
    fingerprint: config.fingerprint,
    revision: 0,
    lastMutationAt: null,
    nextOrdinal: 1,
    consumedThrough: null,
    entries: [],
    cursors: config.sources.map((source) => ({
      streamId: source.streamId,
      sequence: 0,
      batchId: null,
      lastEventRevision: null,
      lastEventAt: null,
      receipt: null,
    })),
  };
}
function parseCursor(
  value: unknown,
  config: HandoffInboxConfig,
  index: number,
  revision: number,
  maximum: number,
): Cursor {
  const row = handoffFields(
    value,
    [
      "streamId",
      "sequence",
      "batchId",
      "lastEventRevision",
      "lastEventAt",
      "receipt",
    ],
    "state_invalid",
  );
  const streamId = config.sources[index]!.streamId;
  if (row.streamId !== streamId) invalid();
  const sequence = handoffInteger(row.sequence),
    batchId = row.batchId === null ? null : handoffDigest(row.batchId);
  const lastEventRevision =
    row.lastEventRevision === null
      ? null
      : handoffInteger(row.lastEventRevision, 1);
  const lastEventAt =
    row.lastEventAt === null
      ? null
      : handoffInteger(row.lastEventAt, 0, maximum);
  let receipt: HandoffReceipt | null = null;
  try {
    if (row.receipt !== null)
      receipt = parseHandoffReceipt(row.receipt, config.publicKey);
  } catch {
    invalid();
  }
  if (
    (sequence === 0) !== (receipt === null) ||
    (sequence === 0) !== (batchId === null) ||
    (sequence === 0) !== (lastEventRevision === null) ||
    (sequence === 0) !== (lastEventAt === null)
  )
    invalid();
  if (
    receipt &&
    (receipt.streamId !== streamId ||
      receipt.receiverId !== config.receiverId ||
      receipt.sequence !== sequence ||
      receipt.batchId !== batchId ||
      receipt.inboxRevision > revision ||
      receipt.acceptedAt > maximum ||
      receipt.acceptedAt < lastEventAt!)
  )
    invalid();
  return {
    streamId,
    sequence,
    batchId,
    lastEventRevision,
    lastEventAt,
    receipt,
  };
}
export function parseHandoffInboxState(
  value: unknown,
  config: HandoffInboxConfig,
): HandoffInboxState {
  const row = handoffFields(
    value,
    [
      "version",
      "kind",
      "fingerprint",
      "revision",
      "lastMutationAt",
      "nextOrdinal",
      "consumedThrough",
      "cursors",
      "entries",
    ],
    "state_invalid",
  );
  if (row.version !== 1 || row.kind !== "alert_inbox") invalid();
  if (handoffDigest(row.fingerprint) !== config.fingerprint)
    throw new HandoffFault("state_config_mismatch");
  const revision = handoffInteger(row.revision),
    nextOrdinal = handoffInteger(row.nextOrdinal, 1);
  const lastMutationAt =
    row.lastMutationAt === null ? null : handoffInteger(row.lastMutationAt);
  if ((revision === 0) !== (lastMutationAt === null)) invalid();
  let consumedThrough: HandoffInboxState["consumedThrough"] = null;
  if (row.consumedThrough !== null) {
    const consumed = handoffFields(
      row.consumedThrough,
      ["id", "ordinal"],
      "state_invalid",
    );
    consumedThrough = {
      id: handoffDigest(consumed.id),
      ordinal: handoffInteger(consumed.ordinal, 1, nextOrdinal - 1),
    };
  }
  if (
    !Array.isArray(row.cursors) ||
    row.cursors.length !== config.sources.length ||
    !Array.isArray(row.entries) ||
    row.entries.length > ALERT_INBOX_LIMIT
  )
    invalid();
  const cursors = row.cursors.map((value, index) =>
    parseCursor(value, config, index, revision, lastMutationAt ?? 0),
  );
  const cursorMap = new Map(cursors.map((cursor) => [cursor.streamId, cursor]));
  const lastByStream = new Map<string, AlertInboxEntry>();
  let previousAcceptanceAt = 0,
    previousInboxRevision = 0;
  const entries: AlertInboxEntry[] = row.entries.map((value, index) => {
    const item = handoffFields(
      value,
      [
        "id",
        "ordinal",
        "streamId",
        "sequence",
        "batchId",
        "monitorFingerprint",
        "acceptedAt",
        "inboxRevision",
        "event",
      ],
      "state_invalid",
    );
    const ordinal = handoffInteger(item.ordinal, 1, nextOrdinal - 1),
      sequence = handoffInteger(item.sequence, 1);
    if (
      ordinal !== (consumedThrough?.ordinal ?? 0) + index + 1 ||
      typeof item.streamId !== "string"
    )
      invalid();
    const cursor = cursorMap.get(item.streamId);
    if (!cursor || sequence > cursor.sequence) invalid();
    const batchId = handoffDigest(item.batchId),
      monitorFingerprint = handoffDigest(item.monitorFingerprint);
    const acceptedAt = handoffInteger(item.acceptedAt, 0, lastMutationAt ?? 0);
    const inboxRevision = handoffInteger(item.inboxRevision, 1, revision);
    let event: MonitorEvent;
    try {
      event = parseMonitorEvent(
        item.event,
        acceptedAt,
        cursor.lastEventRevision!,
      );
    } catch {
      invalid();
    }
    if (
      event.id !==
      handoffHash([
        monitorFingerprint,
        event.revision,
        event.targetId,
        event.rule,
        event.transition,
        event.at,
      ])
    )
      invalid();
    const id = handoffDigest(item.id);
    if (
      id !==
      entryId(
        config.receiverId,
        ordinal,
        item.streamId,
        sequence,
        batchId,
        event.id,
      )
    )
      invalid();
    if (
      sequence === cursor.sequence &&
      (batchId !== cursor.batchId ||
        acceptedAt !== cursor.receipt!.acceptedAt ||
        inboxRevision !== cursor.receipt!.inboxRevision)
    )
      invalid();
    if (
      acceptedAt < previousAcceptanceAt ||
      inboxRevision < previousInboxRevision
    )
      invalid();
    previousAcceptanceAt = acceptedAt;
    previousInboxRevision = inboxRevision;
    if (
      sequence < cursor.sequence &&
      event.revision >= cursor.lastEventRevision!
    )
      invalid();
    const prior = lastByStream.get(item.streamId);
    if (
      prior &&
      (sequence < prior.sequence ||
        event.at < prior.event.at ||
        event.revision < prior.event.revision ||
        (sequence > prior.sequence && event.revision <= prior.event.revision) ||
        (sequence === prior.sequence && batchId !== prior.batchId))
    )
      invalid();
    const entry = {
      id,
      ordinal,
      streamId: item.streamId,
      sequence,
      batchId,
      monitorFingerprint,
      acceptedAt,
      inboxRevision,
      event,
    };
    lastByStream.set(item.streamId, entry);
    return entry;
  });
  if (nextOrdinal !== (consumedThrough?.ordinal ?? 0) + entries.length + 1)
    invalid();
  if (
    new Set(entries.map((entry) => `${entry.streamId}:${entry.event.id}`))
      .size !== entries.length
  )
    invalid();
  for (const cursor of cursors) {
    const latest = lastByStream.get(cursor.streamId);
    if (
      latest &&
      (latest.sequence !== cursor.sequence ||
        latest.event.id !== cursor.receipt!.through ||
        latest.event.revision !== cursor.lastEventRevision ||
        latest.event.at !== cursor.lastEventAt)
    )
      invalid();
    if (
      entries.filter(
        (entry) =>
          entry.streamId === cursor.streamId &&
          entry.sequence === cursor.sequence,
      ).length > (cursor.receipt?.count ?? 0)
    )
      invalid();
  }
  const acceptedBatches = cursors.reduce(
    (sum, cursor) => sum + cursor.sequence,
    0,
  );
  if (
    !Number.isSafeInteger(acceptedBatches) ||
    acceptedBatches > revision ||
    (revision === 0 && (nextOrdinal !== 1 || consumedThrough !== null))
  )
    invalid();
  return {
    version: 1,
    kind: "alert_inbox",
    fingerprint: config.fingerprint,
    revision,
    lastMutationAt,
    nextOrdinal,
    consumedThrough,
    cursors,
    entries,
  };
}
function assertTime(state: HandoffInboxState, now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now < (state.lastMutationAt ?? 0)
  )
    throw new HandoffFault("clock_rollback");
  if (state.revision >= Number.MAX_SAFE_INTEGER)
    throw new HandoffFault("state_full");
}

/** Only the latest sequence can be retried. A chained next batch requires a
 * strictly newer monitor revision, so a bounded cursor also rejects ancient
 * replays after consumption without keeping an unbounded tombstone table. */
export function acceptAlertHandoff(
  config: HandoffInboxConfig,
  previous: unknown | null,
  batchValue: unknown,
  now: number,
): { state: HandoffInboxState; receipt: HandoffReceipt; duplicate: boolean } {
  const batch = verifyHandoffBatch(batchValue, config);
  const state =
    previous === null
      ? empty(config)
      : parseHandoffInboxState(previous, config);
  const cursor = state.cursors.find(
    (cursor) => cursor.streamId === batch.streamId,
  )!;
  if (batch.sequence === cursor.sequence && batch.id === cursor.batchId)
    return { state, receipt: cursor.receipt!, duplicate: true };
  if (
    batch.sequence !== cursor.sequence + 1 ||
    batch.previous !== cursor.batchId ||
    (cursor.lastEventRevision !== null &&
      batch.events[0]!.revision <= cursor.lastEventRevision) ||
    (cursor.lastEventAt !== null && batch.events[0]!.at < cursor.lastEventAt)
  )
    throw new HandoffFault("batch_out_of_order");
  assertTime(state, now);
  if (now < batch.preparedAt) throw new HandoffFault("clock_rollback");
  if (
    state.entries.length + batch.events.length > ALERT_INBOX_LIMIT ||
    state.nextOrdinal > Number.MAX_SAFE_INTEGER - batch.events.length
  )
    throw new HandoffFault("state_full");
  state.revision++;
  state.lastMutationAt = now;
  const receipt = createHandoffReceipt(config, batch, now, state.revision);
  for (const event of batch.events) {
    const ordinal = state.nextOrdinal++;
    state.entries.push({
      id: entryId(
        config.receiverId,
        ordinal,
        batch.streamId,
        batch.sequence,
        batch.id,
        event.id,
      ),
      ordinal,
      streamId: batch.streamId,
      sequence: batch.sequence,
      batchId: batch.id,
      monitorFingerprint: batch.monitorFingerprint,
      acceptedAt: now,
      inboxRevision: state.revision,
      event,
    });
  }
  cursor.sequence = batch.sequence;
  cursor.batchId = batch.id;
  cursor.lastEventRevision = batch.events.at(-1)!.revision;
  cursor.lastEventAt = batch.events.at(-1)!.at;
  cursor.receipt = receipt;
  return {
    state: parseHandoffInboxState(state, config),
    receipt,
    duplicate: false,
  };
}
export function consumeAlertInbox(
  config: HandoffInboxConfig,
  previous: unknown,
  through: string,
  now: number,
): { state: HandoffInboxState; consumed: number } {
  const state = parseHandoffInboxState(previous, config);
  if (through === state.consumedThrough?.id) return { state, consumed: 0 };
  const index = state.entries.findIndex((entry) => entry.id === through);
  if (index < 0) throw new HandoffFault("entry_not_found");
  assertTime(state, now);
  const entry = state.entries[index]!;
  state.entries = state.entries.slice(index + 1);
  state.consumedThrough = { id: entry.id, ordinal: entry.ordinal };
  state.revision++;
  state.lastMutationAt = now;
  return { state: parseHandoffInboxState(state, config), consumed: index + 1 };
}
