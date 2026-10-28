import { randomUUID } from "node:crypto";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import type { MigrationChangeOperation, JsonObject } from "./provider-migration-journal.ts";

type PgExecutor = { unsafe(sql: string, parameters?: unknown[]): Promise<Record<string, any>[]> };
export type CapturedChange = { entityType: string; entityId: string; operation: MigrationChangeOperation; payload: JsonObject | null };
function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = stableValue(child);
    return result;
  }
  return value;
}
function stablePayload(value: unknown): JsonObject | null {
  if (value === null) return null;
  const cleaned = stableValue(value);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) throw new TypeError("Migration capture payload must be a JSON object.");
  return cleaned as JsonObject;
}
export function migrationEntityKey(...parts: unknown[]): string {
  if (parts.some(part => typeof part !== "string" || !part.length)) throw new TypeError("Migration entity key parts must be non-empty strings.");
  return JSON.stringify(parts);
}

/** Capture row snapshots using the same Postgres transaction executor as the domain write. */
export function createPostgresProviderMigrationCapture(sql: any) {
  const journal = createPostgresProviderMigrationJournal(sql);
  async function captureInTransaction(tx: PgExecutor, transactionId: string, changes: readonly CapturedChange[]): Promise<void> {
    if (changes.length === 0) return;
    const sessions = await tx.unsafe("SELECT session_id FROM provider_migration_sessions WHERE source_provider = 'postgres' AND status IN ('recording', 'backfilling', 'catching_up') ORDER BY session_id");
    if (sessions.length === 0) return;
    for (const change of changes) {
      for (const session of sessions) {
        await journal.appendChangeInTransaction(tx, {
          sessionId: String(session.session_id), changeId: randomUUID(), transactionId,
          entityType: change.entityType, entityId: change.entityId, operation: change.operation,
          payload: stablePayload(change.payload),
        });
      }
    }
  }
  return Object.freeze({ captureInTransaction });
}
