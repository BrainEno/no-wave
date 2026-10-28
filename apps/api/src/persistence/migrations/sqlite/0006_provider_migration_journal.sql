CREATE TABLE provider_migration_sessions (
  session_id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (source_provider IN ('sqlite', 'postgres', 'mongodb')),
  target_provider TEXT NOT NULL CHECK (target_provider IN ('sqlite', 'postgres', 'mongodb')),
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'recording', 'backfilling', 'catching_up', 'stopped', 'aborted')),
  next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (source_provider <> target_provider)
);

CREATE TABLE provider_migration_changes (
  session_id TEXT NOT NULL REFERENCES provider_migration_sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  change_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload TEXT CHECK (payload IS NULL OR (json_valid(payload) AND json_type(payload) = 'object')),
  change_hash TEXT NOT NULL CHECK (length(change_hash) = 64),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, sequence),
  UNIQUE (session_id, change_id),
  CHECK ((operation = 'delete' AND payload IS NULL) OR (operation = 'upsert' AND payload IS NOT NULL))
);

CREATE INDEX provider_migration_changes_transaction_idx
  ON provider_migration_changes(session_id, transaction_id, sequence);
CREATE INDEX provider_migration_changes_replay_idx
  ON provider_migration_changes(session_id, sequence);

CREATE TABLE provider_migration_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES provider_migration_sessions(session_id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE provider_migration_applied_changes (
  session_id TEXT NOT NULL REFERENCES provider_migration_sessions(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  change_id TEXT NOT NULL,
  change_hash TEXT NOT NULL CHECK (length(change_hash) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, sequence),
  UNIQUE (session_id, change_id)
);
