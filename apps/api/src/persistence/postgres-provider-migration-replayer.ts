import {
  assertChangeMatchesEnvelope,
  MigrationJournalError,
  type MigrationChange,
} from "./provider-migration-journal.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { getMigrationEntitySpec, migrationEntityKeyValues, prepareMigrationRowPayload } from "./provider-migration-row-applier.ts";

type PgExecutor = { unsafe(sql: string, parameters?: unknown[]): Promise<Record<string, any>[]> };
type PgDatabase = PgExecutor & { begin<T>(work: (tx: PgExecutor) => Promise<T>): Promise<T> };

/** PostgreSQL target applier; row mutations and apply-ledger/checkpoint writes commit together. */
export function createPostgresProviderMigrationReplayer(sql: PgDatabase) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js database connection is required.");
  }
  const journal = createPostgresProviderMigrationJournal(sql);

  async function applyRow(tx: PgExecutor, change: MigrationChange): Promise<void> {
    const valid = assertChangeMatchesEnvelope(change);
    const spec = getMigrationEntitySpec(valid.entityType);
    if (valid.operation === "delete") {
      const keys = migrationEntityKeyValues(valid.entityId, spec.primaryKey);
      const where = spec.primaryKey.map((column, index) => column + " = $" + (index + 1)).join(" AND ");
      await tx.unsafe("DELETE FROM " + spec.table + " WHERE " + where, keys);
      return;
    }
    if (!valid.payload || typeof valid.payload !== "object" || Array.isArray(valid.payload)) {
      throw new MigrationJournalError("INVALID_PAYLOAD", "Upsert changes must contain a row object.");
    }
    const prepared = prepareMigrationRowPayload("postgres", valid.entityType, valid.entityId, valid.payload as Record<string, unknown>);
    const jsonColumns = new Set(prepared.spec.jsonColumns ?? []);
    const placeholders = prepared.columns.map((column, index) => "$" + (index + 1) + (jsonColumns.has(column) ? "::jsonb" : "")).join(", ");
    const conflictKeys = prepared.spec.primaryKey.join(", ");
    const mutableColumns = prepared.columns.filter(column => !prepared.spec.primaryKey.includes(column));
    const conflict = mutableColumns.length
      ? "DO UPDATE SET " + mutableColumns.map(column => column + " = EXCLUDED." + column).join(", ")
      : "DO NOTHING";
    await tx.unsafe(
      "INSERT INTO " + prepared.spec.table + " (" + prepared.columns.join(", ") + ") VALUES (" + placeholders + ") ON CONFLICT (" + conflictKeys + ") " + conflict,
      prepared.values,
    );
  }

  async function applyTransaction(changes: readonly MigrationChange[]): Promise<void> {
    if (!changes.length) return;
    const first = changes[0];
    const seen = new Set<string>();
    let expected = first.sequence;
    for (const change of changes) {
      assertChangeMatchesEnvelope(change);
      if (change.sessionId !== first.sessionId || change.transactionId !== first.transactionId) {
        throw new MigrationJournalError("TRANSACTION_ENVELOPE_MISMATCH", "All changes in an apply transaction must share one source transaction envelope.");
      }
      if (change.sequence !== expected++) {
        throw new MigrationJournalError("SOURCE_SEQUENCE_GAP", "Changes in a source transaction must have contiguous sequence numbers.");
      }
      if (seen.has(change.changeId)) throw new MigrationJournalError("DUPLICATE_CHANGE_IN_BATCH", "A transaction batch contains a duplicate change ID.");
      seen.add(change.changeId);
    }

    await sql.begin(async (tx) => {
      for (const change of changes) {
        const applied = await journal.markAppliedInTransaction(tx, change);
        if (!applied.duplicate) await applyRow(tx, change);
      }
    });
  }

  return Object.freeze({
    provider: "postgres" as const,
    getSession: journal.getSession,
    createSession: journal.createSession,
    transitionSession: journal.transitionSession,
    getCheckpoint: journal.getCheckpoint,
    readChangeBatch: journal.readChangeBatch,
    applyTransaction,
  });
}
