-- Database-local operational jobs: deliberately excluded from provider transfer.
CREATE TABLE notion_import_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  request_key_hash TEXT NOT NULL CHECK (length(request_key_hash) = 64),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'expired')),
  total INTEGER NOT NULL CHECK (total BETWEEN 0 AND 200),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed BETWEEN 0 AND total),
  payload TEXT,
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes BETWEEN 0 AND 12582912),
  report TEXT CHECK (report IS NULL OR (json_valid(report) AND length(CAST(report AS BLOB)) <= 131072)),
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  UNIQUE (owner_id, request_key_hash),
  CHECK ((state IN ('queued', 'running') AND payload IS NOT NULL AND stored_bytes = length(CAST(payload AS BLOB)))
    OR (state NOT IN ('queued', 'running') AND payload IS NULL AND stored_bytes = 0)),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK (state <> 'succeeded' OR completed = total)
);
CREATE INDEX notion_import_jobs_owner_idx ON notion_import_jobs(owner_id, created_at DESC, id);
CREATE INDEX notion_import_jobs_queue_idx ON notion_import_jobs(created_at, id) WHERE state = 'queued';
CREATE INDEX notion_import_jobs_expiry_idx ON notion_import_jobs(expires_at) WHERE state IN ('queued', 'running');
