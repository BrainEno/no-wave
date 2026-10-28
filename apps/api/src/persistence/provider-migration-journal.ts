import { createHash, randomUUID } from "node:crypto";

export type MigrationProvider = "sqlite" | "postgres" | "mongodb";
export type MigrationSessionStatus = "prepared" | "recording" | "backfilling" | "catching_up" | "stopped" | "aborted";
export type MigrationChangeOperation = "upsert" | "delete";
export type JsonObject = Record<string, unknown>;
export type MigrationSessionInput = { sessionId: string; sourceProvider: MigrationProvider; targetProvider: MigrationProvider; schemaVersion: string };
export type MigrationChangeInput = { sessionId: string; changeId: string; transactionId: string; entityType: string; entityId: string; operation: MigrationChangeOperation; payload: JsonObject | null };
export type ValidatedMigrationChange = MigrationChangeInput & { payloadJson: string | null; changeHash: string };
export type MigrationChange = MigrationChangeInput & { sequence: number; changeHash: string; recordedAt: string; duplicate?: boolean };

export class MigrationJournalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "MigrationJournalError"; this.code = code; }
}

const providers = new Set<MigrationProvider>(["sqlite", "postgres", "mongodb"]);
const statuses = new Set<MigrationSessionStatus>(["prepared", "recording", "backfilling", "catching_up", "stopped", "aborted"]);
const activeStatuses = new Set<MigrationSessionStatus>(["recording", "backfilling", "catching_up"]);
const transitions: Record<MigrationSessionStatus, MigrationSessionStatus[]> = {
  prepared: ["recording", "aborted"], recording: ["backfilling", "catching_up", "aborted"],
  backfilling: ["catching_up", "aborted"], catching_up: ["stopped", "aborted"], stopped: [], aborted: [],
};
export const createMigrationTransactionId = (): string => randomUUID();
export const createMigrationChangeId = (): string => randomUUID();

function text(name: string, value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > max)
    throw new MigrationJournalError("INVALID_INPUT", name + " must be a trimmed non-empty string (maximum " + max + " characters).");
  return value;
}
function canonicalize(value: unknown, path: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MigrationJournalError("INVALID_PAYLOAD", path + " cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((v, i) => canonicalize(v, path + "[" + i + "]")).join(",") + "]";
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new MigrationJournalError("INVALID_PAYLOAD", path + " must contain plain JSON objects.");
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map(k => {
      if (obj[k] === undefined) throw new MigrationJournalError("INVALID_PAYLOAD", path + "." + k + " cannot be undefined.");
      return JSON.stringify(k) + ":" + canonicalize(obj[k], path + "." + k);
    }).join(",") + "}";
  }
  throw new MigrationJournalError("INVALID_PAYLOAD", path + " is not JSON-serializable.");
}
export function canonicalJson(value: unknown): string { return canonicalize(value, "payload"); }
export function validateMigrationSession(input: MigrationSessionInput): MigrationSessionInput {
  const sessionId = text("sessionId", input?.sessionId, 128);
  if (!providers.has(input?.sourceProvider)) throw new MigrationJournalError("INVALID_INPUT", "sourceProvider is unsupported.");
  if (!providers.has(input?.targetProvider)) throw new MigrationJournalError("INVALID_INPUT", "targetProvider is unsupported.");
  if (input.sourceProvider === input.targetProvider) throw new MigrationJournalError("INVALID_INPUT", "Source and target providers must differ.");
  return { sessionId, sourceProvider: input.sourceProvider, targetProvider: input.targetProvider, schemaVersion: text("schemaVersion", input?.schemaVersion, 100) };
}
export function assertMigrationTransition(from: MigrationSessionStatus, to: MigrationSessionStatus): void {
  if (!statuses.has(from) || !statuses.has(to) || !transitions[from].includes(to))
    throw new MigrationJournalError("INVALID_TRANSITION", "Migration status cannot transition from " + from + " to " + to + ".");
}
export function isMigrationSessionActive(value: unknown): value is "recording" | "backfilling" | "catching_up" {
  return typeof value === "string" && activeStatuses.has(value as MigrationSessionStatus);
}
export function validateMigrationSequence(value: unknown, name = "sequence", allowZero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1))
    throw new MigrationJournalError("INVALID_SEQUENCE", name + " must be a safe " + (allowZero ? "non-negative" : "positive") + " integer.");
  return value as number;
}
export function validateMigrationChange(input: MigrationChangeInput): ValidatedMigrationChange {
  const normalized: MigrationChangeInput = {
    sessionId: text("sessionId", input?.sessionId, 128), changeId: text("changeId", input?.changeId, 128),
    transactionId: text("transactionId", input?.transactionId, 128), entityType: text("entityType", input?.entityType, 128),
    entityId: text("entityId", input?.entityId, 512), operation: input?.operation, payload: input?.payload,
  };
  if (normalized.operation !== "upsert" && normalized.operation !== "delete")
    throw new MigrationJournalError("INVALID_INPUT", "operation must be upsert or delete.");
  if (normalized.operation === "delete" && normalized.payload !== null)
    throw new MigrationJournalError("INVALID_PAYLOAD", "Delete changes must have a null payload.");
  if (normalized.operation === "upsert" && (!normalized.payload || typeof normalized.payload !== "object" || Array.isArray(normalized.payload)))
    throw new MigrationJournalError("INVALID_PAYLOAD", "Upsert changes must contain a JSON object payload.");
  const payloadJson = normalized.payload === null ? null : canonicalJson(normalized.payload);
  const changeHash = createHash("sha256").update(canonicalJson(normalized), "utf8").digest("hex");
  return { ...normalized, payloadJson, changeHash };
}
export function parseMigrationPayload(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MigrationJournalError("INVALID_STORED_PAYLOAD", "Stored payload is not a JSON object.");
  return parsed as JsonObject;
}
export function assertChangeMatchesEnvelope(change: MigrationChange): ValidatedMigrationChange & { sequence: number } {
  const normalized = validateMigrationChange(change);
  const sequence = validateMigrationSequence(change.sequence);
  if (change.changeHash !== normalized.changeHash) throw new MigrationJournalError("CHANGE_HASH_MISMATCH", "Change payload hash is inconsistent.");
  return { ...normalized, sequence };
}
