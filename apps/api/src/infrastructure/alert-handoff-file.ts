import {
  HandoffFault,
  HANDOFF_ARTIFACT_MAX_BYTES,
  handoffArtifactText,
  handoffJson,
  type HandoffBatch,
  type HandoffInboxConfig,
  type HandoffReceipt,
  type HandoffSenderConfig,
  type HandoffVerificationConfig,
} from "../application/alert-handoff-protocol.ts";
import { parseHandoffSenderState } from "../application/alert-handoff-sender.ts";
import { parseHandoffInboxState } from "../application/alert-handoff-inbox.ts";
import {
  parseHandoffInboxConfig,
  parseHandoffSenderConfig,
  parseHandoffVerificationConfig,
} from "./alert-handoff-config.ts";
import {
  assertPrivateOperationParent,
  openPrivateOperationJournal,
  privateOperationPath,
  readPrivateOperationFile,
  readPrivateOperationSnapshot,
  writePrivateOperationArtifact,
} from "./private-operation-file.ts";

export const HANDOFF_STATE_MAX_BYTES = 2 * 1024 * 1024;
export function readHandoffConfig(
  path: string,
  role: "sender",
): HandoffSenderConfig;
export function readHandoffConfig(
  path: string,
  role: "inbox",
): HandoffInboxConfig;
export function readHandoffConfig(
  path: string,
  role: "verify",
): HandoffVerificationConfig;
export function readHandoffConfig(
  path: string,
  role: "sender" | "inbox" | "verify",
): HandoffSenderConfig | HandoffInboxConfig | HandoffVerificationConfig {
  try {
    assertPrivateOperationParent(privateOperationPath(path));
    const bytes = readPrivateOperationFile(path, {
      maximum: 16 * 1024,
      privateFile: true,
    })!;
    const value = handoffJson(bytes, "config_invalid");
    if (role === "verify") return parseHandoffVerificationConfig(value);
    return role === "sender"
      ? parseHandoffSenderConfig(value)
      : parseHandoffInboxConfig(value);
  } catch {
    throw new HandoffFault("config_invalid");
  }
}
export function readHandoffArtifact(path: string): unknown {
  try {
    assertPrivateOperationParent(privateOperationPath(path));
    const bytes = readPrivateOperationFile(path, {
      maximum: HANDOFF_ARTIFACT_MAX_BYTES,
      privateFile: true,
    })!;
    return handoffJson(bytes, "artifact_invalid");
  } catch {
    throw new HandoffFault("artifact_invalid");
  }
}
export function publishHandoffArtifact(
  path: string,
  value: HandoffBatch | HandoffReceipt,
): boolean {
  return writePrivateOperationArtifact(
    path,
    Buffer.from(handoffArtifactText(value)),
    HANDOFF_ARTIFACT_MAX_BYTES,
  );
}
export function readHandoffSenderFile(
  path: string,
  config: HandoffSenderConfig,
  binding: string,
) {
  const snapshot = readPrivateOperationSnapshot(path, HANDOFF_STATE_MAX_BYTES);
  return snapshot === null
    ? null
    : parseHandoffSenderState(snapshot.value, config, binding);
}
export function readHandoffInboxFile(path: string, config: HandoffInboxConfig) {
  const snapshot = readPrivateOperationSnapshot(path, HANDOFF_STATE_MAX_BYTES);
  return snapshot === null
    ? null
    : parseHandoffInboxState(snapshot.value, config);
}
export function openHandoffSenderFile(
  path: string,
  config: HandoffSenderConfig,
  binding: string,
) {
  return openPrivateOperationJournal(path, {
    maximum: HANDOFF_STATE_MAX_BYTES,
    parse: (value) => parseHandoffSenderState(value, config, binding),
    revision: (state) => state.revision,
  });
}
export function openHandoffInboxFile(path: string, config: HandoffInboxConfig) {
  return openPrivateOperationJournal(path, {
    maximum: HANDOFF_STATE_MAX_BYTES,
    parse: (value) => parseHandoffInboxState(value, config),
    revision: (state) => state.revision,
  });
}

export function publishHandoffProfile(path: string, value: unknown): boolean {
  parseHandoffVerificationConfig(value);
  return writePrivateOperationArtifact(
    path,
    Buffer.from(JSON.stringify(value) + "\n"),
    16 * 1024,
  );
}
