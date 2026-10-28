import {
  assertChangeMatchesEnvelope, assertMigrationTransition, isMigrationSessionActive,
  MigrationJournalError, parseMigrationPayload, validateMigrationChange, validateMigrationSequence,
  validateMigrationSession, type MigrationChange, type MigrationChangeInput, type MigrationSessionInput,
  type MigrationSessionStatus,
} from "./provider-migration-journal.ts";

type Row = Record<string, any>;
type Statement = { get(...args: any[]): Row | undefined; all(...args: any[]): Row[]; run(...args: any[]): { changes: number | bigint } };
export type SqliteMigrationExecutor = { prepare(sql: string): Statement; readonly isTransaction?: boolean };

function requireTransaction(tx: SqliteMigrationExecutor): void {
  if (tx.isTransaction !== true) throw new MigrationJournalError("TRANSACTION_REQUIRED", "Call this method inside the source/target SQLite transaction.");
}
function seq(row: Row, key: string): number {
  return validateMigrationSequence(Number(row[key]), key, key === "last_sequence");
}
function mapSession(row: Row) {
  return {
    sessionId: row.session_id, sourceProvider: row.source_provider, targetProvider: row.target_provider,
    schemaVersion: row.schema_version, status: row.status as MigrationSessionStatus,
    nextSequence: seq(row, "next_sequence"), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function mapChange(row: Row, duplicate = false): MigrationChange {
  return {
    sessionId: row.session_id, sequence: seq(row, "sequence"), changeId: row.change_id,
    transactionId: row.transaction_id, entityType: row.entity_type, entityId: row.entity_id,
    operation: row.operation, payload: parseMigrationPayload(row.payload), changeHash: String(row.change_hash).trim(),
    recordedAt: row.recorded_at, ...(duplicate ? { duplicate: true } : {}),
  };
}
function sessionRow(db: SqliteMigrationExecutor, id: string): Row {
  const row = db.prepare("SELECT * FROM provider_migration_sessions WHERE session_id = ?").get(id);
  if (!row) throw new MigrationJournalError("SESSION_NOT_FOUND", "Migration session " + id + " does not exist.");
  return row;
}
function mapCheckpoint(db: SqliteMigrationExecutor, id: string): number {
  const row = db.prepare("SELECT last_sequence FROM provider_migration_checkpoints WHERE session_id = ?").get(id);
  return row ? seq(row, "last_sequence") : 0;
}
function compareDuplicate(existing: Row, change: ReturnType<typeof validateMigrationChange>): MigrationChange {
  if (String(existing.change_hash).trim() !== change.changeHash) throw new MigrationJournalError("CHANGE_ID_CONFLICT", "Change ID was reused with a different payload.");
  return mapChange(existing, true);
}

export function createSqliteProviderMigrationJournal(db: SqliteMigrationExecutor) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database connection is required.");

  function createSession(input: MigrationSessionInput) {
    const s = validateMigrationSession(input);
    db.prepare("INSERT INTO provider_migration_sessions (session_id, source_provider, target_provider, schema_version) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
      .run(s.sessionId, s.sourceProvider, s.targetProvider, s.schemaVersion);
    const row = sessionRow(db, s.sessionId);
    if (row.source_provider !== s.sourceProvider || row.target_provider !== s.targetProvider || row.schema_version !== s.schemaVersion)
      throw new MigrationJournalError("SESSION_ID_CONFLICT", "Session ID already exists with different provider/schema settings.");
    return mapSession(row);
  }

  function getSession(sessionId: string) { return mapSession(sessionRow(db, sessionId)); }

  function transitionSession(input: { sessionId: string; expectedStatus: MigrationSessionStatus; nextStatus: MigrationSessionStatus }): boolean {
    assertMigrationTransition(input.expectedStatus, input.nextStatus);
    const result = db.prepare("UPDATE provider_migration_sessions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND status = ?")
      .run(input.nextStatus, input.sessionId, input.expectedStatus);
    if (Number(result.changes) === 1) return true;
    const row = sessionRow(db, input.sessionId);
    return row.status === input.nextStatus;
  }

  function appendChangeInTransaction(tx: SqliteMigrationExecutor, input: MigrationChangeInput): MigrationChange {
    requireTransaction(tx);
    const change = validateMigrationChange(input);
    const existing = tx.prepare("SELECT * FROM provider_migration_changes WHERE session_id = ? AND change_id = ?").get(change.sessionId, change.changeId);
    if (existing) return compareDuplicate(existing, change);
    const session = sessionRow(tx, change.sessionId);
    if (!isMigrationSessionActive(session.status)) throw new MigrationJournalError("SESSION_NOT_RECORDING", "Migration session does not accept changes in status " + session.status + ".");
    const updated = tx.prepare("UPDATE provider_migration_sessions SET next_sequence = next_sequence + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND status IN ('recording', 'backfilling', 'catching_up')")
      .run(change.sessionId);
    if (Number(updated.changes) !== 1) throw new MigrationJournalError("SESSION_NOT_RECORDING", "Migration session stopped accepting changes.");
    const sequence = seq(tx.prepare("SELECT next_sequence - 1 AS sequence FROM provider_migration_sessions WHERE session_id = ?").get(change.sessionId)!, "sequence");
    tx.prepare("INSERT INTO provider_migration_changes (session_id, sequence, change_id, transaction_id, entity_type, entity_id, operation, payload, change_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(change.sessionId, sequence, change.changeId, change.transactionId, change.entityType, change.entityId, change.operation, change.payloadJson, change.changeHash);
    const row = tx.prepare("SELECT * FROM provider_migration_changes WHERE session_id = ? AND sequence = ?").get(change.sessionId, sequence);
    if (!row) throw new MigrationJournalError("JOURNAL_INSERT_FAILED", "SQLite did not return the inserted change.");
    return mapChange(row);
  }

  function readChangeBatch(input: { sessionId: string; afterSequence: number; limit?: number }): MigrationChange[] {
    const after = validateMigrationSequence(input.afterSequence, "afterSequence", true);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new MigrationJournalError("INVALID_INPUT", "limit must be between 1 and 1000.");
    sessionRow(db, input.sessionId);
    const rows = db.prepare("SELECT * FROM provider_migration_changes WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(input.sessionId, after, limit + 1);
    if (rows.length <= limit) return rows.map(row => mapChange(row));
    const last = rows[limit - 1];
    const firstExtra = rows[limit];
    if (last.transaction_id !== firstExtra.transaction_id) return rows.slice(0, limit).map(row => mapChange(row));
    const start = rows.findIndex(row => row.transaction_id === last.transaction_id);
    if (start > 0) return rows.slice(0, start).map(row => mapChange(row));
    const rest = db.prepare("SELECT * FROM provider_migration_changes WHERE session_id = ? AND transaction_id = ? AND sequence > ? ORDER BY sequence")
      .all(input.sessionId, last.transaction_id, last.sequence);
    return rows.slice(0, limit).concat(rest).map(row => mapChange(row));
  }

  function getCheckpoint(sessionId: string): number { sessionRow(db, sessionId); return mapCheckpoint(db, sessionId); }

  function markAppliedInTransaction(tx: SqliteMigrationExecutor, change: MigrationChange) {
    requireTransaction(tx);
    const valid = assertChangeMatchesEnvelope(change);
    const session = sessionRow(tx, valid.sessionId);
    if (!isMigrationSessionActive(session.status)) throw new MigrationJournalError("SESSION_NOT_ACTIVE", "Migration session is not active.");
    const duplicates = tx.prepare("SELECT * FROM provider_migration_applied_changes WHERE session_id = ? AND (sequence = ? OR change_id = ?)")
      .all(valid.sessionId, valid.sequence, valid.changeId);
    if (duplicates.length) {
      const row = duplicates[0];
      if (duplicates.length !== 1 || Number(row.sequence) !== valid.sequence || row.change_id !== valid.changeId || String(row.change_hash).trim() !== valid.changeHash)
        throw new MigrationJournalError("APPLIED_CHANGE_CONFLICT", "A replay sequence/change ID was already applied with different content.");
      const checkpoint = mapCheckpoint(tx, valid.sessionId);
      if (checkpoint < valid.sequence) throw new MigrationJournalError("CHECKPOINT_CORRUPT", "Applied-change ledger is ahead of the checkpoint.");
      return { duplicate: true, lastSequence: checkpoint };
    }
    const checkpoint = mapCheckpoint(tx, valid.sessionId);
    if (valid.sequence !== checkpoint + 1) throw new MigrationJournalError("OUT_OF_ORDER_CHANGE", "Expected sequence " + (checkpoint + 1) + ", received " + valid.sequence + ".");
    tx.prepare("INSERT INTO provider_migration_applied_changes (session_id, sequence, change_id, change_hash) VALUES (?, ?, ?, ?)")
      .run(valid.sessionId, valid.sequence, valid.changeId, valid.changeHash);
    tx.prepare("INSERT INTO provider_migration_checkpoints (session_id, last_sequence) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE provider_migration_checkpoints.last_sequence = ?")
      .run(valid.sessionId, valid.sequence, checkpoint);
    if (mapCheckpoint(tx, valid.sessionId) !== valid.sequence) throw new MigrationJournalError("CHECKPOINT_RACE", "Checkpoint changed while applying a migration change.");
    return { duplicate: false, lastSequence: valid.sequence };
  }

  return Object.freeze({ createSession, getSession, transitionSession, appendChangeInTransaction, readChangeBatch, getCheckpoint, markAppliedInTransaction });
}
