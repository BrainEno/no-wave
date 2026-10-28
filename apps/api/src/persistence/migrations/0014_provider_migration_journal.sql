CREATE TABLE provider_migration_sessions (
  session_id text PRIMARY KEY,
  source_provider text NOT NULL CHECK (source_provider IN ('sqlite', 'postgres', 'mongodb')),
  target_provider text NOT NULL CHECK (target_provider IN ('sqlite', 'postgres', 'mongodb')),
  schema_version text NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'recording', 'backfilling', 'catching_up', 'stopped', 'aborted')),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_provider <> target_provider)
);

CREATE TABLE provider_migration_changes (
  session_id text NOT NULL REFERENCES provider_migration_sessions(session_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  change_id text NOT NULL,
  transaction_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  change_hash char(64) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sequence),
  UNIQUE (session_id, change_id),
  CHECK ((operation = 'delete' AND payload IS NULL) OR (operation = 'upsert' AND payload IS NOT NULL))
);

CREATE INDEX provider_migration_changes_transaction_idx
  ON provider_migration_changes(session_id, transaction_id, sequence);
CREATE INDEX provider_migration_changes_replay_idx
  ON provider_migration_changes(session_id, sequence);

CREATE TABLE provider_migration_checkpoints (
  session_id text PRIMARY KEY REFERENCES provider_migration_sessions(session_id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_migration_applied_changes (
  session_id text NOT NULL REFERENCES provider_migration_sessions(session_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  change_id text NOT NULL,
  change_hash char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sequence),
  UNIQUE (session_id, change_id)
);
