import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { monitorFields, type MonitorEvent } from "./operational-monitor.ts";
import {
  MONITOR_EVENT_LIMIT,
  parseMonitorEvent,
} from "./operational-monitor-state.ts";

export type HandoffFaultCode =
  | "arguments_invalid"
  | "config_invalid"
  | "artifact_invalid"
  | "artifact_conflict"
  | "state_invalid"
  | "state_config_mismatch"
  | "state_binding_mismatch"
  | "state_io"
  | "state_locked"
  | "state_missing"
  | "state_full"
  | "clock_rollback"
  | "monitor_prefix_changed"
  | "batch_out_of_order"
  | "entry_not_found"
  | "receipt_required"
  | "receipt_not_found"
  | "cursor_invalid"
  | "page_stale"
  | "cancelled"
  | "output_failed";
export class HandoffFault extends Error {
  readonly code: HandoffFaultCode;
  constructor(code: HandoffFaultCode) {
    super(code);
    this.name = "HandoffFault";
    this.code = code;
  }
}
export type HandoffSenderConfig = {
  version: 1;
  role: "sender";
  streamId: string;
  receiverId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  receiverKey: KeyObject;
  fingerprint: string;
};
export type HandoffInboxConfig = {
  version: 1;
  role: "inbox";
  receiverId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  sources: { streamId: string; publicKey: KeyObject }[];
  fingerprint: string;
};
export type HandoffVerificationConfig = {
  version: 1;
  role: "verify";
  streamId: string;
  receiverId: string;
  senderKey: KeyObject;
  receiverKey: KeyObject;
  fingerprint: string;
};
export type HandoffBatch = {
  version: 1;
  type: "alert_batch";
  streamId: string;
  receiverId: string;
  sequence: number;
  previous: string | null;
  monitorFingerprint: string;
  preparedAt: number;
  events: MonitorEvent[];
  id: string;
  signature: string;
};
export type HandoffReceipt = {
  version: 1;
  type: "alert_receipt";
  streamId: string;
  receiverId: string;
  sequence: number;
  batchId: string;
  count: number;
  through: string;
  acceptedAt: number;
  inboxRevision: number;
  signature: string;
};
export const HANDOFF_ARTIFACT_MAX_BYTES = 256 * 1024;
export const HANDOFF_HASH = /^[a-f0-9]{64}$/;
export const HANDOFF_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Same plain-object policy as the monitor, but this wire protocol has no
 * optional fields. Signers and verifiers must agree on one closed schema. */
export function handoffFields(
  value: unknown,
  fields: readonly string[],
  code: HandoffFaultCode,
): Record<string, unknown> {
  try {
    const row = monitorFields(value, fields, "state_invalid");
    if (Object.keys(row).length !== fields.length) throw new HandoffFault(code);
    return row;
  } catch {
    throw new HandoffFault(code);
  }
}
export function handoffInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new HandoffFault("state_invalid");
  return value;
}
export function handoffHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function handoffDigest(value: unknown): string {
  if (typeof value !== "string" || !HANDOFF_HASH.test(value))
    throw new HandoffFault("state_invalid");
  return value;
}
export function handoffJson(bytes: Buffer, code: HandoffFaultCode): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HandoffFault(code);
  }
}
export function handoffArtifactText(
  value: HandoffBatch | HandoffReceipt,
): string {
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > HANDOFF_ARTIFACT_MAX_BYTES)
    throw new HandoffFault("state_full");
  return text;
}
function signatureBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length !== 88)
    throw new HandoffFault("artifact_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value)
    throw new HandoffFault("artifact_invalid");
  return bytes;
}
function signingInput(domain: "batch" | "receipt", value: unknown): Buffer {
  return Buffer.from(
    `no-wave-alert-${domain}-v1\0${JSON.stringify(value)}`,
    "utf8",
  );
}
function signed(
  domain: "batch" | "receipt",
  value: unknown,
  key: KeyObject,
): string {
  return sign(null, signingInput(domain, value), key).toString("base64");
}
function authenticated(
  domain: "batch" | "receipt",
  value: unknown,
  signature: unknown,
  key: KeyObject,
): string {
  if (
    !verify(null, signingInput(domain, value), key, signatureBytes(signature))
  )
    throw new HandoffFault("artifact_invalid");
  return signature as string;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !HANDOFF_UUID.test(value))
    throw new HandoffFault("artifact_invalid");
  return value;
}

/** Reconstruct rather than spread untrusted objects: property order is not a
 * signature input, nor can an extra field become unaudited forwarding data. */
function batchBody(value: unknown): Omit<HandoffBatch, "id" | "signature"> {
  const row = handoffFields(
    value,
    [
      "version",
      "type",
      "streamId",
      "receiverId",
      "sequence",
      "previous",
      "monitorFingerprint",
      "preparedAt",
      "events",
      "id",
      "signature",
    ],
    "artifact_invalid",
  );
  if (row.version !== 1 || row.type !== "alert_batch")
    throw new HandoffFault("artifact_invalid");
  const streamId = uuid(row.streamId),
    receiverId = uuid(row.receiverId);
  const sequence = handoffInteger(row.sequence, 1),
    preparedAt = handoffInteger(row.preparedAt);
  const previous = row.previous === null ? null : handoffDigest(row.previous);
  if ((sequence === 1) !== (previous === null))
    throw new HandoffFault("artifact_invalid");
  const monitorFingerprint = handoffDigest(row.monitorFingerprint);
  if (
    !Array.isArray(row.events) ||
    row.events.length < 1 ||
    row.events.length > MONITOR_EVENT_LIMIT
  )
    throw new HandoffFault("artifact_invalid");
  const events = row.events.map((value) =>
    parseMonitorEvent(value, preparedAt, Number.MAX_SAFE_INTEGER),
  );
  const lastByRule = new Map<string, MonitorEvent>();
  const transitions = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!,
      prior = events[index - 1];
    // Monitor IDs bind the original configuration, revision and transition.
    // This is provenance/integrity, not a fresh health observation.
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
      throw new HandoffFault("artifact_invalid");
    if (
      prior &&
      (event.revision < prior.revision ||
        (event.revision === prior.revision
          ? event.at !== prior.at
          : event.at <= prior.at))
    )
      throw new HandoffFault("artifact_invalid");
    const key = `${event.targetId}:${event.rule}`;
    const transitionKey = `${event.revision}:${key}`;
    if (transitions.has(transitionKey))
      throw new HandoffFault("artifact_invalid");
    transitions.add(transitionKey);
    const previousRule = lastByRule.get(key);
    if (previousRule) {
      if (previousRule.transition === "resolved") {
        if (event.transition !== "firing")
          throw new HandoffFault("artifact_invalid");
      } else if (
        event.transition === "firing" ||
        event.firingSince !== previousRule.firingSince
      )
        throw new HandoffFault("artifact_invalid");
    }
    lastByRule.set(key, event);
  }
  if (new Set(events.map((event) => event.targetId)).size > 16)
    throw new HandoffFault("artifact_invalid");
  if (new Set(events.map((event) => event.id)).size !== events.length)
    throw new HandoffFault("artifact_invalid");
  return {
    version: 1,
    type: "alert_batch",
    streamId,
    receiverId,
    sequence,
    previous,
    monitorFingerprint,
    preparedAt,
    events,
  };
}
export function createHandoffBatch(
  config: HandoffSenderConfig,
  events: readonly MonitorEvent[],
  monitorFingerprint: string,
  sequence: number,
  previous: string | null,
  preparedAt: number,
): HandoffBatch {
  const body = {
    version: 1 as const,
    type: "alert_batch" as const,
    streamId: config.streamId,
    receiverId: config.receiverId,
    sequence,
    previous,
    monitorFingerprint,
    preparedAt,
    events: structuredClone([...events]),
  };
  const id = handoffHash(body);
  const result = {
    ...body,
    id,
    signature: signed("batch", { ...body, id }, config.privateKey),
  };
  return parseHandoffBatch(
    result,
    config.publicKey,
    config.streamId,
    config.receiverId,
  );
}
export function parseHandoffBatch(
  value: unknown,
  publicKey: KeyObject,
  expectedStream: string,
  expectedReceiver: string,
): HandoffBatch {
  try {
    const body = batchBody(value);
    const row = value as Record<string, unknown>,
      id = handoffDigest(row.id);
    if (
      body.streamId !== expectedStream ||
      body.receiverId !== expectedReceiver ||
      id !== handoffHash(body)
    )
      throw new HandoffFault("artifact_invalid");
    const unsigned = { ...body, id };
    const signature = authenticated(
      "batch",
      unsigned,
      row.signature,
      publicKey,
    );
    const result = { ...unsigned, signature };
    handoffArtifactText(result);
    return result;
  } catch {
    throw new HandoffFault("artifact_invalid");
  }
}
export function verifyHandoffBatch(
  value: unknown,
  config: HandoffInboxConfig,
): HandoffBatch {
  if (!value || typeof value !== "object" || !("streamId" in value))
    throw new HandoffFault("artifact_invalid");
  const source = config.sources.find(
    (source) => source.streamId === value.streamId,
  );
  if (!source) throw new HandoffFault("artifact_invalid");
  return parseHandoffBatch(
    value,
    source.publicKey,
    source.streamId,
    config.receiverId,
  );
}
function receiptBody(value: unknown): Omit<HandoffReceipt, "signature"> {
  const row = handoffFields(
    value,
    [
      "version",
      "type",
      "streamId",
      "receiverId",
      "sequence",
      "batchId",
      "count",
      "through",
      "acceptedAt",
      "inboxRevision",
      "signature",
    ],
    "artifact_invalid",
  );
  if (row.version !== 1 || row.type !== "alert_receipt")
    throw new HandoffFault("artifact_invalid");
  return {
    version: 1,
    type: "alert_receipt",
    streamId: uuid(row.streamId),
    receiverId: uuid(row.receiverId),
    sequence: handoffInteger(row.sequence, 1),
    batchId: handoffDigest(row.batchId),
    count: handoffInteger(row.count, 1, MONITOR_EVENT_LIMIT),
    through: handoffDigest(row.through),
    acceptedAt: handoffInteger(row.acceptedAt),
    inboxRevision: handoffInteger(row.inboxRevision, 1),
  };
}
export function createHandoffReceipt(
  config: HandoffInboxConfig,
  batch: HandoffBatch,
  now: number,
  revision: number,
): HandoffReceipt {
  const body: Omit<HandoffReceipt, "signature"> = {
    version: 1,
    type: "alert_receipt",
    streamId: batch.streamId,
    receiverId: config.receiverId,
    sequence: batch.sequence,
    batchId: batch.id,
    count: batch.events.length,
    through: batch.events.at(-1)!.id,
    acceptedAt: now,
    inboxRevision: revision,
  };
  return { ...body, signature: signed("receipt", body, config.privateKey) };
}
export function parseHandoffReceipt(
  value: unknown,
  publicKey: KeyObject,
): HandoffReceipt {
  try {
    const body = receiptBody(value);
    const signature = authenticated(
      "receipt",
      body,
      (value as Record<string, unknown>).signature,
      publicKey,
    );
    return { ...body, signature };
  } catch {
    throw new HandoffFault("artifact_invalid");
  }
}
export function verifyHandoffReceipt(
  value: unknown,
  config: Pick<HandoffSenderConfig, "streamId" | "receiverId" | "receiverKey">,
  batch: HandoffBatch,
): HandoffReceipt {
  const receipt = parseHandoffReceipt(value, config.receiverKey);
  if (
    receipt.receiverId !== config.receiverId ||
    receipt.streamId !== config.streamId ||
    receipt.sequence !== batch.sequence ||
    receipt.batchId !== batch.id ||
    receipt.count !== batch.events.length ||
    receipt.through !== batch.events.at(-1)!.id ||
    receipt.acceptedAt < batch.preparedAt
  )
    throw new HandoffFault("artifact_invalid");
  return receipt;
}
