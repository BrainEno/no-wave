-- Ciphertext and leases are local to this database/key, not portable domain data.
CREATE TABLE notion_import_jobs (
  id text PRIMARY KEY CHECK (length(id) = 36),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  request_key_hash text NOT NULL CHECK (length(request_key_hash) = 64),
  fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'expired')),
  total integer NOT NULL CHECK (total BETWEEN 0 AND 200),
  completed integer NOT NULL DEFAULT 0 CHECK (completed BETWEEN 0 AND total),
  payload text,
  stored_bytes integer NOT NULL CHECK (stored_bytes BETWEEN 0 AND 12582912),
  report text CHECK (report IS NULL OR octet_length(report) <= 131072),
  lease_token text,
  lease_expires_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  retain_until bigint NOT NULL,
  UNIQUE (owner_id, request_key_hash),
  CHECK ((state IN ('queued', 'running') AND payload IS NOT NULL AND stored_bytes = octet_length(payload))
    OR (state NOT IN ('queued', 'running') AND payload IS NULL AND stored_bytes = 0)),
  CHECK ((state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK (state <> 'succeeded' OR completed = total)
);
CREATE INDEX notion_import_jobs_owner_idx ON notion_import_jobs(owner_id, created_at DESC, id);
CREATE INDEX notion_import_jobs_queue_idx ON notion_import_jobs(created_at, id) WHERE state = 'queued';
CREATE INDEX notion_import_jobs_expiry_idx ON notion_import_jobs(expires_at) WHERE state IN ('queued', 'running');
