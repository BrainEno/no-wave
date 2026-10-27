-- SQLite contract counterpart; this adapter is not a runtime provider.
CREATE TABLE auth_accounts (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);
CREATE TABLE auth_access_tokens (
  token_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_access_tokens_session_idx ON auth_access_tokens (session_id);
CREATE TABLE auth_refresh_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX auth_refresh_tokens_session_idx ON auth_refresh_tokens (session_id);
CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY CHECK (length(key) = 64),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  reset_at TEXT NOT NULL
);
CREATE INDEX auth_rate_limits_reset_idx ON auth_rate_limits (reset_at);
