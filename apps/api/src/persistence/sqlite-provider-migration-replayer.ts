import {
  assertChangeMatchesEnvelope,
  assertMigrationReplaySchema,
  MigrationJournalError,
  type MigrationChange,
} from "./provider-migration-journal.ts";
import { createSqliteProviderMigrationJournal, type SqliteMigrationExecutor } from "./sqlite-provider-migration-journal.ts";

type SqliteReplayDatabase = SqliteMigrationExecutor & {
  exec(sql: string): void;
  readonly isTransaction: boolean;
};
import { prepareMigrationRowPayload, migrationEntityKeyValues } from "./provider-migration-row-applier.ts";

/** SQLite target applier; row mutations and apply-ledger/checkpoint writes share one transaction. */
export function createSqliteProviderMigrationReplayer(db: SqliteReplayDatabase) {
  if (!db || typeof db.prepare !== "function" || typeof db.isTransaction !== "boolean") {
    throw new TypeError("A SQLite DatabaseSync connection is required.");
  }
  const journal = createSqliteProviderMigrationJournal(db);

  function assertForeignKeysEnabled(): void {
    const row = db.prepare("PRAGMA foreign_keys").get();
    if (!row || Number(row.foreign_keys) !== 1) {
      throw new MigrationJournalError("FOREIGN_KEYS_DISABLED", "SQLite replay requires foreign-key constraint enforcement on the target connection.");
    }
  }

  function assertEmptyMediaBaseline(): void {
    assertForeignKeysEnabled();
    const row = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM media_assets) OR
      EXISTS(SELECT 1 FROM article_media_refs) OR
      EXISTS(SELECT 1 FROM article_translations) OR
      EXISTS(SELECT 1 FROM user_profiles WHERE avatar_media_id IS NOT NULL OR lower(avatar_url) LIKE '%/media/%') AS populated`).get();
    if (row?.populated) throw new MigrationJournalError("UNVERIFIED_MEDIA_BASELINE", "Replay requires an empty media baseline; existing snapshots need coordinated rebuilding and reconciliation.");
  }

  function applyRow(change: MigrationChange): void {
    const valid = assertChangeMatchesEnvelope(change);
    const spec = prepareSpec(valid.entityType);
    if (valid.operation === "delete") {
      const keys = migrationEntityKeyValues(valid.entityId, spec.primaryKey);
      // The reference table is keyed to the article, not to the translation.
      // Removing a locale independently must therefore release its set too.
      if (valid.entityType === "article_translations") {
        db.prepare("DELETE FROM article_media_refs WHERE article_id = ? AND locale = ?").run(...keys);
      }
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
    if (prepared.articleMediaRefs !== null) {
      const [articleId, locale] = prepared.primaryKeyValues;
      db.prepare("DELETE FROM article_media_refs WHERE article_id = ? AND locale = ?").run(articleId, locale);
      const insert = db.prepare("INSERT INTO article_media_refs (asset_id, article_id, locale) VALUES (?, ?, ?)");
      for (const assetId of prepared.articleMediaRefs) insert.run(assetId, articleId, locale);
    }
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
      // PRAGMA cannot change while this transaction is open. Check every apply,
      // not just preparation, so a later connection setting cannot bypass FKs.
      assertForeignKeysEnabled();
      const session = journal.getSession(first.sessionId);
      assertMigrationReplaySchema(session.schemaVersion);
      if (session.targetProvider !== "sqlite") throw new MigrationJournalError("REPLAY_PROVIDER_MISMATCH", "The session does not target this provider.");
      if (journal.getCheckpoint(first.sessionId) === 0) assertEmptyMediaBaseline();
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
    assertEmptyMediaBaseline,
    applyTransaction,
  });
}

import { getMigrationEntitySpec as getSpec } from "./provider-migration-row-applier.ts";
