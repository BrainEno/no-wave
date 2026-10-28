import { randomUUID } from "node:crypto";
import { createSqliteProviderMigrationJournal, type SqliteMigrationExecutor } from "./sqlite-provider-migration-journal.ts";
import type { MigrationChangeOperation, JsonObject } from "./provider-migration-journal.ts";

export type CapturedChange = { entityType: string; entityId: string; operation: MigrationChangeOperation; payload: JsonObject | null };
function stablePayload(value: unknown): JsonObject | null {
  if (value === null) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Migration capture payload must be JSON serializable.");
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Migration capture payload must be a JSON object.");
  return parsed as JsonObject;
}
export function migrationEntityKey(...parts: unknown[]): string {
  if (parts.some(part => typeof part !== "string" || !part.length)) throw new TypeError("Migration entity key parts must be non-empty strings.");
  return JSON.stringify(parts);
}

/** Capture current row snapshots using the same SQLite transaction as the domain write. */
export function createSqliteProviderMigrationCapture(db: SqliteMigrationExecutor) {
  const journal = createSqliteProviderMigrationJournal(db);
  function captureInTransaction(tx: SqliteMigrationExecutor, transactionId: string, changes: readonly CapturedChange[]): void {
    if (tx.isTransaction !== true) throw new Error("Domain change capture must run inside its SQLite transaction.");
    if (changes.length === 0) return;
    const sessions = tx.prepare("SELECT session_id FROM provider_migration_sessions WHERE source_provider = 'sqlite' AND status IN ('recording', 'backfilling', 'catching_up') ORDER BY session_id").all();
    if (sessions.length === 0) return;
    for (const change of changes) {
      for (const session of sessions) {
        journal.appendChangeInTransaction(tx, {
          sessionId: String(session.session_id), changeId: randomUUID(), transactionId,
          entityType: change.entityType, entityId: change.entityId, operation: change.operation,
          payload: stablePayload(change.payload),
        });
      }
    }
  }
  return Object.freeze({ captureInTransaction });
}
