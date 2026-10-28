import {
  assertChangeMatchesEnvelope, assertMigrationTransition, isMigrationSessionActive,
  MigrationJournalError, parseMigrationPayload, validateMigrationChange, validateMigrationSequence,
  validateMigrationSession, type MigrationChange, type MigrationChangeInput, type MigrationSessionInput,
  type MigrationSessionStatus,
} from "./provider-migration-journal.ts";

type Row = Record<string, any>;
type PgExecutor = any;
type PgDatabase = any;

function fieldText(row: Row, key: string): string {
  if (typeof row[key] !== "string") throw new MigrationJournalError("INVALID_STORED_ROW", "Stored field " + key + " is not text.");
  return row[key];
}
function seq(row: Row, key: string): number { return validateMigrationSequence(Number(row[key]), key, key === "last_sequence"); }
function dateText(value: unknown): string { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function mapSession(row: Row) {
  return { sessionId: fieldText(row, "session_id"), sourceProvider: fieldText(row, "source_provider"),
    targetProvider: fieldText(row, "target_provider"), schemaVersion: fieldText(row, "schema_version"),
    status: fieldText(row, "status") as MigrationSessionStatus, nextSequence: seq(row, "next_sequence"),
    createdAt: dateText(row.created_at), updatedAt: dateText(row.updated_at) };
}
function mapChange(row: Row, duplicate = false): MigrationChange {
  return { sessionId: fieldText(row, "session_id"), sequence: seq(row, "sequence"), changeId: fieldText(row, "change_id"),
    transactionId: fieldText(row, "transaction_id"), entityType: fieldText(row, "entity_type"), entityId: fieldText(row, "entity_id"),
    operation: fieldText(row, "operation") as MigrationChange["operation"], payload: parseMigrationPayload(row.payload),
    changeHash: fieldText(row, "change_hash").trim(), recordedAt: dateText(row.recorded_at),
    ...(duplicate ? { duplicate: true } : {}) };
}
async function sessionRow(db: PgExecutor, id: string, lock = false): Promise<Row> {
  const rows = await db.unsafe("SELECT * FROM provider_migration_sessions WHERE session_id = $1" + (lock ? " FOR UPDATE" : ""), [id]);
  if (!rows[0]) throw new MigrationJournalError("SESSION_NOT_FOUND", "Migration session " + id + " does not exist.");
  return rows[0];
}
async function checkpointFrom(db: PgExecutor, id: string): Promise<number> {
  await sessionRow(db, id);
  const rows = await db.unsafe("SELECT last_sequence FROM provider_migration_checkpoints WHERE session_id = $1", [id]);
  return rows[0] ? seq(rows[0], "last_sequence") : 0;
}
function compareDuplicate(existing: Row, change: ReturnType<typeof validateMigrationChange>): MigrationChange {
  if (fieldText(existing, "change_hash").trim() !== change.changeHash) throw new MigrationJournalError("CHANGE_ID_CONFLICT", "Change ID was reused with a different payload.");
  return mapChange(existing, true);
}

export function createPostgresProviderMigrationJournal(sql: PgDatabase) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") throw new TypeError("A postgres.js database connection is required.");

  async function createSession(input: MigrationSessionInput) {
    const s = validateMigrationSession(input);
    await sql.unsafe("INSERT INTO provider_migration_sessions (session_id, source_provider, target_provider, schema_version) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO NOTHING", [s.sessionId, s.sourceProvider, s.targetProvider, s.schemaVersion]);
    const row = await sessionRow(sql, s.sessionId);
    if (row.source_provider !== s.sourceProvider || row.target_provider !== s.targetProvider || row.schema_version !== s.schemaVersion)
      throw new MigrationJournalError("SESSION_ID_CONFLICT", "Session ID already exists with different provider/schema settings.");
    return mapSession(row);
  }
  async function getSession(sessionId: string) { return mapSession(await sessionRow(sql, sessionId)); }
  async function transitionSession(input: { sessionId: string; expectedStatus: MigrationSessionStatus; nextStatus: MigrationSessionStatus }): Promise<boolean> {
    assertMigrationTransition(input.expectedStatus, input.nextStatus);
    const rows = await sql.unsafe("UPDATE provider_migration_sessions SET status = $1, updated_at = now() WHERE session_id = $2 AND status = $3 RETURNING status", [input.nextStatus, input.sessionId, input.expectedStatus]);
    if (rows.length === 1) return true;
    return (await sessionRow(sql, input.sessionId)).status === input.nextStatus;
  }
  async function appendChangeInTransaction(tx: PgExecutor, input: MigrationChangeInput): Promise<MigrationChange> {
    const change = validateMigrationChange(input);
    const session = await sessionRow(tx, change.sessionId, true);
    const existing = await tx.unsafe("SELECT * FROM provider_migration_changes WHERE session_id = $1 AND change_id = $2", [change.sessionId, change.changeId]);
    if (existing[0]) return compareDuplicate(existing[0], change);
    if (!isMigrationSessionActive(session.status)) throw new MigrationJournalError("SESSION_NOT_RECORDING", "Migration session does not accept changes in status " + session.status + ".");
    const allocated = await tx.unsafe("UPDATE provider_migration_sessions SET next_sequence = next_sequence + 1, updated_at = now() WHERE session_id = $1 AND status IN ('recording', 'backfilling', 'catching_up') RETURNING next_sequence - 1 AS sequence", [change.sessionId]);
    if (!allocated[0]) throw new MigrationJournalError("SESSION_NOT_RECORDING", "Migration session stopped accepting changes.");
    const sequence = validateMigrationSequence(Number(allocated[0].sequence));
    const inserted = await tx.unsafe("INSERT INTO provider_migration_changes (session_id, sequence, change_id, transaction_id, entity_type, entity_id, operation, payload, change_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING *",
      [change.sessionId, sequence, change.changeId, change.transactionId, change.entityType, change.entityId, change.operation, change.payloadJson, change.changeHash]);
    if (!inserted[0]) throw new MigrationJournalError("JOURNAL_INSERT_FAILED", "PostgreSQL did not return the inserted change.");
    return mapChange(inserted[0]);
  }
  async function readChangeBatch(input: { sessionId: string; afterSequence: number; limit?: number }): Promise<MigrationChange[]> {
    const after = validateMigrationSequence(input.afterSequence, "afterSequence", true);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new MigrationJournalError("INVALID_INPUT", "limit must be between 1 and 1000.");
    await sessionRow(sql, input.sessionId);
    const rows = await sql.unsafe("SELECT * FROM provider_migration_changes WHERE session_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3", [input.sessionId, after, limit + 1]);
    if (rows.length <= limit) return rows.map(row => mapChange(row));
    const last = rows[limit - 1], firstExtra = rows[limit];
    if (last.transaction_id !== firstExtra.transaction_id) return rows.slice(0, limit).map(row => mapChange(row));
    const start = rows.findIndex(row => row.transaction_id === last.transaction_id);
    if (start > 0) return rows.slice(0, start).map(row => mapChange(row));
    const rest = await sql.unsafe("SELECT * FROM provider_migration_changes WHERE session_id = $1 AND transaction_id = $2 AND sequence > $3 ORDER BY sequence", [input.sessionId, last.transaction_id, last.sequence]);
    return rows.slice(0, limit).concat(rest).map(row => mapChange(row));
  }
  async function getCheckpoint(sessionId: string): Promise<number> { return checkpointFrom(sql, sessionId); }
  async function markAppliedInTransaction(tx: PgExecutor, change: MigrationChange) {
    const valid = assertChangeMatchesEnvelope(change);
    const session = await sessionRow(tx, valid.sessionId, true);
    if (!isMigrationSessionActive(session.status)) throw new MigrationJournalError("SESSION_NOT_ACTIVE", "Migration session is not active.");
    const duplicates = await tx.unsafe("SELECT * FROM provider_migration_applied_changes WHERE session_id = $1 AND (sequence = $2 OR change_id = $3)", [valid.sessionId, valid.sequence, valid.changeId]);
    if (duplicates.length) {
      const row = duplicates[0];
      if (duplicates.length !== 1 || Number(row.sequence) !== valid.sequence || row.change_id !== valid.changeId || fieldText(row, "change_hash").trim() !== valid.changeHash)
        throw new MigrationJournalError("APPLIED_CHANGE_CONFLICT", "A replay sequence/change ID was already applied with different content.");
      const checkpoint = await checkpointFrom(tx, valid.sessionId);
      if (checkpoint < valid.sequence) throw new MigrationJournalError("CHECKPOINT_CORRUPT", "Applied-change ledger is ahead of the checkpoint.");
      return { duplicate: true, lastSequence: checkpoint };
    }
    const current = await checkpointFrom(tx, valid.sessionId);
    if (valid.sequence !== current + 1) throw new MigrationJournalError("OUT_OF_ORDER_CHANGE", "Expected sequence " + (current + 1) + ", received " + valid.sequence + ".");
    await tx.unsafe("INSERT INTO provider_migration_applied_changes (session_id, sequence, change_id, change_hash) VALUES ($1, $2, $3, $4)", [valid.sessionId, valid.sequence, valid.changeId, valid.changeHash]);
    const saved = await tx.unsafe("INSERT INTO provider_migration_checkpoints (session_id, last_sequence) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET last_sequence = EXCLUDED.last_sequence, updated_at = now() WHERE provider_migration_checkpoints.last_sequence = $3 RETURNING last_sequence", [valid.sessionId, valid.sequence, current]);
    if (saved.length !== 1) throw new MigrationJournalError("CHECKPOINT_RACE", "The durable replay checkpoint changed concurrently.");
    return { duplicate: false, lastSequence: validateMigrationSequence(Number(saved[0].last_sequence), "last_sequence", true) };
  }
  return Object.freeze({ createSession, getSession, transitionSession, appendChangeInTransaction, readChangeBatch, getCheckpoint, markAppliedInTransaction });
}
