import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import {
  HandoffFault,
  HANDOFF_UUID,
  handoffFields,
  handoffHash,
  type HandoffInboxConfig,
  type HandoffSenderConfig,
  type HandoffVerificationConfig,
} from "../application/alert-handoff-protocol.ts";

function encoded(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new HandoffFault("config_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new HandoffFault("config_invalid");
  return bytes;
}
function publicText(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64");
}
function privateKey(value: unknown): KeyObject {
  const bytes = encoded(value, 128);
  const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !key.export({ type: "pkcs8", format: "der" }).equals(bytes)
  )
    throw new HandoffFault("config_invalid");
  return key;
}
function publicKey(value: unknown): KeyObject {
  const bytes = encoded(value, 128);
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519" || publicText(key) !== value)
    throw new HandoffFault("config_invalid");
  return key;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !HANDOFF_UUID.test(value))
    throw new HandoffFault("config_invalid");
  return value;
}

/** Explicit private config only: no environment, endpoint, key discovery,
 * fallback algorithm, shared signing key or automatic peer registration. */
export function parseHandoffSenderConfig(value: unknown): HandoffSenderConfig {
  try {
    const row = handoffFields(
      value,
      [
        "version",
        "role",
        "streamId",
        "receiverId",
        "signingKey",
        "receiverKey",
      ],
      "config_invalid",
    );
    if (row.version !== 1 || row.role !== "sender")
      throw new HandoffFault("config_invalid");
    const streamId = uuid(row.streamId),
      receiverId = uuid(row.receiverId);
    if (streamId === receiverId) throw new HandoffFault("config_invalid");
    const signing = privateKey(row.signingKey),
      ownPublic = createPublicKey(signing),
      peer = publicKey(row.receiverKey);
    if (publicText(ownPublic) === publicText(peer))
      throw new HandoffFault("config_invalid");
    const fingerprint = handoffHash({
      version: 1,
      role: "sender",
      streamId,
      receiverId,
      publicKey: publicText(ownPublic),
      receiverKey: publicText(peer),
    });
    return {
      version: 1,
      role: "sender",
      streamId,
      receiverId,
      privateKey: signing,
      publicKey: ownPublic,
      receiverKey: peer,
      fingerprint,
    };
  } catch {
    throw new HandoffFault("config_invalid");
  }
}
export function parseHandoffInboxConfig(value: unknown): HandoffInboxConfig {
  try {
    const row = handoffFields(
      value,
      ["version", "role", "receiverId", "signingKey", "sources"],
      "config_invalid",
    );
    if (row.version !== 1 || row.role !== "inbox")
      throw new HandoffFault("config_invalid");
    const receiverId = uuid(row.receiverId),
      signing = privateKey(row.signingKey),
      ownPublic = createPublicKey(signing);
    if (
      !Array.isArray(row.sources) ||
      row.sources.length < 1 ||
      row.sources.length > 16
    )
      throw new HandoffFault("config_invalid");
    const sources = row.sources
      .map((value) => {
        const source = handoffFields(
          value,
          ["streamId", "publicKey"],
          "config_invalid",
        );
        return {
          streamId: uuid(source.streamId),
          publicKey: publicKey(source.publicKey),
        };
      })
      .sort((a, b) => a.streamId.localeCompare(b.streamId));
    const keys = sources.map((source) => publicText(source.publicKey));
    if (
      new Set(sources.map((source) => source.streamId)).size !==
        sources.length ||
      new Set(keys).size !== keys.length ||
      keys.includes(publicText(ownPublic)) ||
      sources.some((source) => source.streamId === receiverId)
    )
      throw new HandoffFault("config_invalid");
    const fingerprint = handoffHash({
      version: 1,
      role: "inbox",
      receiverId,
      publicKey: publicText(ownPublic),
      sources: sources.map((source) => ({
        streamId: source.streamId,
        publicKey: publicText(source.publicKey),
      })),
    });
    return {
      version: 1,
      role: "inbox",
      receiverId,
      privateKey: signing,
      publicKey: ownPublic,
      sources,
      fingerprint,
    };
  } catch {
    throw new HandoffFault("config_invalid");
  }
}

/** Verifier profiles never accept private material or discover keys from the
 * artifact being verified. The profile itself needs an independent trusted
 * distribution path; a self-supplied profile is not authenticated provenance. */
export function parseHandoffVerificationConfig(
  value: unknown,
): HandoffVerificationConfig {
  try {
    const row = handoffFields(
      value,
      ["version", "role", "streamId", "receiverId", "senderKey", "receiverKey"],
      "config_invalid",
    );
    if (row.version !== 1 || row.role !== "verify")
      throw new HandoffFault("config_invalid");
    const streamId = uuid(row.streamId),
      receiverId = uuid(row.receiverId);
    const senderKey = publicKey(row.senderKey),
      receiverKey = publicKey(row.receiverKey);
    if (
      streamId === receiverId ||
      publicText(senderKey) === publicText(receiverKey)
    )
      throw new HandoffFault("config_invalid");
    const fingerprint = handoffHash({
      version: 1,
      role: "verify",
      streamId,
      receiverId,
      senderKey: publicText(senderKey),
      receiverKey: publicText(receiverKey),
    });
    return {
      version: 1,
      role: "verify",
      streamId,
      receiverId,
      senderKey,
      receiverKey,
      fingerprint,
    };
  } catch {
    throw new HandoffFault("config_invalid");
  }
}
