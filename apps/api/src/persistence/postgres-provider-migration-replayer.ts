import {
  assertChangeMatchesEnvelope,
  assertMigrationReplaySchema,
  MigrationJournalError,
  type MigrationChange,
} from "./provider-migration-journal.ts";
import { createPostgresProviderMigrationJournal } from "./postgres-provider-migration-journal.ts";
import { getMigrationEntitySpec, migrationEntityKeyValues, prepareMigrationRowPayload } from "./provider-migration-row-applier.ts";
import type { PgDatabase, PgExecutor } from "./postgres-driver.ts";

/** PostgreSQL target applier; row mutations and apply-ledger/checkpoint writes commit together. */
export function createPostgresProviderMigrationReplayer(sql: PgDatabase) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new TypeError("A postgres.js database connection is required.");
  }
  const journal = createPostgresProviderMigrationJournal(sql);

  async function assertForeignKeysEnabled(executor: PgExecutor): Promise<void> {
    const [row] = await executor.unsafe<{ role: string }>("SELECT current_setting('session_replication_role') AS role");
    // PostgreSQL implements foreign keys as triggers; replica mode disables
    // ordinary constraint triggers even though the schema still declares them.
    if (!row || (row.role !== "origin" && row.role !== "local")) {
      throw new MigrationJournalError("FOREIGN_KEYS_DISABLED", "PostgreSQL replay requires foreign-key trigger enforcement on the target connection.");
    }
  }

  async function assertEmptyMediaBaseline(executor: PgExecutor = sql): Promise<void> {
    await assertForeignKeysEnabled(executor);
    const [row] = await executor.unsafe<{ populated: boolean }>(`SELECT
      EXISTS(SELECT 1 FROM media_assets) OR
      EXISTS(SELECT 1 FROM article_media_refs) OR
      EXISTS(SELECT 1 FROM article_translations) OR
      EXISTS(SELECT 1 FROM user_profiles WHERE avatar_media_id IS NOT NULL OR lower(avatar_url) LIKE '%/media/%') AS populated`);
    if (row?.populated) throw new MigrationJournalError("UNVERIFIED_MEDIA_BASELINE", "Replay requires an empty media baseline; existing snapshots need coordinated rebuilding and reconciliation.");
  }

  async function applyRow(tx: PgExecutor, change: MigrationChange): Promise<void> {
    const valid = assertChangeMatchesEnvelope(change);
    const spec = getMigrationEntitySpec(valid.entityType);
    if (valid.operation === "delete") {
      const keys = migrationEntityKeyValues(valid.entityId, spec.primaryKey);
      if (valid.entityType === "article_translations") {
        await tx.unsafe("DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2", keys);
      }
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
    if (prepared.articleMediaRefs !== null) {
      const [articleId, locale] = prepared.primaryKeyValues;
      await tx.unsafe("DELETE FROM article_media_refs WHERE article_id = $1 AND locale = $2", [articleId, locale]);
      if (prepared.articleMediaRefs.length) {
        // Insert the captured IDs directly: a missing target asset must fail its
        // foreign key and roll back the translation and checkpoint, not vanish.
        await tx.unsafe("INSERT INTO article_media_refs (asset_id, article_id, locale) SELECT asset_id, $2, $3 FROM unnest($1::text[]) AS asset_id", [prepared.articleMediaRefs, articleId, locale]);
      }
    }
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
      // Check this transaction's connection each time; pool connections may have
      // different settings and a prior checkpoint is not evidence of enforcement.
      await assertForeignKeysEnabled(tx);
      // Serialize this preflight with the checkpoint writer for this session.
      const [session] = await tx.unsafe("SELECT schema_version, target_provider FROM provider_migration_sessions WHERE session_id = $1 FOR UPDATE", [first.sessionId]);
      if (!session) throw new MigrationJournalError("SESSION_NOT_FOUND", "The target migration session does not exist.");
      assertMigrationReplaySchema(session.schema_version);
      if (session.target_provider !== "postgres") throw new MigrationJournalError("REPLAY_PROVIDER_MISMATCH", "The session does not target this provider.");
      const [checkpoint] = await tx.unsafe("SELECT last_sequence FROM provider_migration_checkpoints WHERE session_id = $1", [first.sessionId]);
      if (!checkpoint || Number(checkpoint.last_sequence) === 0) await assertEmptyMediaBaseline(tx);
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
    assertEmptyMediaBaseline: () => assertEmptyMediaBaseline(),
    applyTransaction,
  });
}
