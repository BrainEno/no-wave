-- SQLite contract counterpart: one expiring single-use digest per purpose, and a
-- verification stamp on the account. The raw token is never stored.
ALTER TABLE auth_accounts
  ADD COLUMN email_verified_at TEXT;

CREATE TABLE auth_identity_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX auth_identity_tokens_user_purpose_idx
  ON auth_identity_tokens (user_id, purpose);
CREATE INDEX auth_identity_tokens_expiry_idx
  ON auth_identity_tokens (expires_at);
