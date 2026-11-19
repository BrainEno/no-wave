import { sign, verify } from "node:crypto";
import {
  parseHandoffInboxState,
  type AlertInboxEntry,
} from "./alert-handoff-inbox.ts";
import {
  HandoffFault,
  HANDOFF_HASH,
  HANDOFF_UUID,
  handoffFields,
  handoffHash,
  handoffInteger,
  handoffJson,
  type HandoffInboxConfig,
  type HandoffReceipt,
} from "./alert-handoff-protocol.ts";

type PageCursor = {
  version: 1;
  receiverId: string;
  fingerprint: string;
  revision: number;
  nextOrdinal: number;
  stateDigest: string;
};
export type AlertInboxPage = {
  version: 1;
  event: "alert_inbox_read";
  revision: number;
  pending: number;
  entries: AlertInboxEntry[];
  through: string | null;
  remaining: number;
  continuation: string | null;
};
const CURSOR_MAX = 2048;
function cursorBytes(value: PageCursor): Buffer {
  return Buffer.from("no-wave-alert-page-v1\0" + JSON.stringify(value));
}
function encodeCursor(config: HandoffInboxConfig, cursor: PageCursor): string {
  const signature = sign(null, cursorBytes(cursor), config.privateKey).toString(
    "base64",
  );
  return Buffer.from(JSON.stringify({ ...cursor, signature })).toString(
    "base64url",
  );
}
function decodeCursor(config: HandoffInboxConfig, text: string): PageCursor {
  try {
    if (
      text.length < 1 ||
      text.length > CURSOR_MAX ||
      !/^[A-Za-z0-9_-]+$/.test(text)
    )
      throw new HandoffFault("cursor_invalid");
    const bytes = Buffer.from(text, "base64url");
    if (bytes.toString("base64url") !== text)
      throw new HandoffFault("cursor_invalid");
    const row = handoffFields(
      handoffJson(bytes, "cursor_invalid"),
      [
        "version",
        "receiverId",
        "fingerprint",
        "revision",
        "nextOrdinal",
        "stateDigest",
        "signature",
      ],
      "cursor_invalid",
    );
    if (
      row.version !== 1 ||
      row.receiverId !== config.receiverId ||
      row.fingerprint !== config.fingerprint ||
      typeof row.stateDigest !== "string" ||
      !HANDOFF_HASH.test(row.stateDigest) ||
      typeof row.signature !== "string"
    )
      throw new HandoffFault("cursor_invalid");
    const cursor: PageCursor = {
      version: 1,
      receiverId: config.receiverId,
      fingerprint: config.fingerprint,
      revision: handoffInteger(row.revision),
      nextOrdinal: handoffInteger(row.nextOrdinal, 1),
      stateDigest: row.stateDigest,
    };
    const signature = Buffer.from(row.signature, "base64");
    if (
      signature.length !== 64 ||
      signature.toString("base64") !== row.signature ||
      !verify(null, cursorBytes(cursor), config.publicKey, signature)
    )
      throw new HandoffFault("cursor_invalid");
    return cursor;
  } catch {
    throw new HandoffFault("cursor_invalid");
  }
}

/** Pagination is observational, not a consumption acknowledgement. Every
 * continuation pins an exact atomic file snapshot, so concurrent receives or
 * consumption force a restart instead of quietly skipping/duplicating pages. */
export function readAlertInboxPage(
  config: HandoffInboxConfig,
  value: unknown,
  limit: number,
  continuation: string | null,
): AlertInboxPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    throw new HandoffFault("arguments_invalid");
  const state = parseHandoffInboxState(value, config);
  const stateDigest = handoffHash(state);
  let start = 0;
  if (continuation !== null) {
    const cursor = decodeCursor(config, continuation);
    if (
      cursor.revision !== state.revision ||
      cursor.stateDigest !== stateDigest
    )
      throw new HandoffFault("page_stale");
    start = state.entries.findIndex(
      (entry) => entry.ordinal === cursor.nextOrdinal,
    );
    if (start < 0) throw new HandoffFault("cursor_invalid");
  }
  const entries = state.entries.slice(start, start + limit),
    next = state.entries[start + entries.length];
  const token =
    next === undefined
      ? null
      : encodeCursor(config, {
          version: 1,
          receiverId: config.receiverId,
          fingerprint: config.fingerprint,
          revision: state.revision,
          nextOrdinal: next.ordinal,
          stateDigest,
        });
  return {
    version: 1,
    event: "alert_inbox_read",
    revision: state.revision,
    pending: state.entries.length,
    entries,
    through: entries.at(-1)?.id ?? null,
    remaining: state.entries.length - start - entries.length,
    continuation: token,
  };
}

/** Re-publish only the persisted latest receipt. Never synthesize proof from a
 * consumed ordinal or a guessed ID, and never pretend historical receipts are
 * retained indefinitely. This read does not lock, mutate or refresh evidence. */
export function recoverAlertReceipt(
  config: HandoffInboxConfig,
  value: unknown,
  streamId: string,
  sequence: number,
  batchId: string,
): HandoffReceipt {
  if (
    !HANDOFF_UUID.test(streamId) ||
    !HANDOFF_HASH.test(batchId) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  )
    throw new HandoffFault("arguments_invalid");
  const state = parseHandoffInboxState(value, config);
  const cursor = state.cursors.find((cursor) => cursor.streamId === streamId);
  if (
    !cursor?.receipt ||
    cursor.sequence !== sequence ||
    cursor.batchId !== batchId
  )
    throw new HandoffFault("receipt_not_found");
  return cursor.receipt;
}
