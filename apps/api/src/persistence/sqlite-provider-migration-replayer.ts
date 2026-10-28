import {
  assertChangeMatchesEnvelope,
  MigrationJournalError,
  type MigrationChange,
} from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationJournal, type SqliteMigrationExecutor } from "./sqlite-provider-migration-journal.ts";
import { prepareMigrationRowPayload, migrationEntityKeyValues } from "./provider-migration-row-applier.ts";

/** SQLite target applier; row mutations and apply-ledger/checkpoint writes share one transaction. */
export function createSqliteProviderMigrationReplayer(db: SqliteMigrationExecutor) {
  if (!db || typeof db.prepare !== "function" || typeof db.isTransaction !== "boolean") {
    throw new TypeError("A SQLite DatabaseSync connection is required.");
  }
  const journal = createSqliteProviderMigrationJournal(db);

  function applyRow(change: MigrationChange): void {
    const valid = assertChangeMatchesEnvelope(change);
    const spec = prepareSpec(valid.entityType);
    if (valid.operation === "delete") {
      const keys = migrationEntityKeyValues(valid.entityId, spec.primaryKey);
      const where = spec.primaryKey.map(column => column + " = ?").join(" AND ");
      db.prepare("DELETE FROM " + spec.table + " WHERE " + where).run(...keys);
      return;
    }
    if (!valid.payload || typeof valid.payload !== "object" || Array.isArray(valid.payload)) {
      throw new MigrationJournalError("INVALID_PAYLOAD", "Upsert changes must contain a row object.");
    }
    const prepared = prepareMigrationRowPayload("sqlite", valid.entityType, valid.entityId, valid.payload as Record<string, unknown>);
    const columns = prepared.columns;
    const placeholders = columns.map(() => "?").join(", ");
    const conflictKeys = prepared.spec.primaryKey.join(", ");
    const mutableColumns = columns.filter(column => !prepared.spec.primaryKey.includes(column));
    const conflict = mutableColumns.length
      ? "DO UPDATE SET " + mutableColumns.map(column => column + " = excluded." + column).join(", ")
      : "DO NOTHING";
    db.prepare(
      "INSERT INTO " + prepared.spec.table + " (" + columns.join(", ") + ") VALUES (" + placeholders + ") ON CONFLICT (" + conflictKeys + ") " + conflict,
    ).run(...prepared.values);
  }

  // Separate resolver keeps delete processing on the same strict table allowlist.
  function prepareSpec(entityType: string) {
    const payload = { ...getSpec(entityType) };
    return payload;
  }

  function applyTransaction(changes: readonly MigrationChange[]): void {
    if (!changes.length) return;
    if (db.isTransaction) throw new MigrationJournalError("TRANSACTION_ALREADY_OPEN", "The target database already has an open transaction.");
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

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const change of changes) {
        const applied = journal.markAppliedInTransaction(db, change);
        if (!applied.duplicate) applyRow(change);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original replay error. */ }
      throw error;
    }
  }

  return Object.freeze({
    provider: "sqlite" as const,
    getSession: journal.getSession,
    createSession: journal.createSession,
    transitionSession: journal.transitionSession,
    getCheckpoint: journal.getCheckpoint,
    readChangeBatch: journal.readChangeBatch,
    applyTransaction,
  });
}

import { getMigrationEntitySpec as getSpec } from "./provider-migration-row-applier.ts";
