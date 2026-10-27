-- Self-hosted credentials and independently revocable device sessions.
-- No existing external issuer accounts or revoked session rows are rewritten.
CREATE TABLE auth_accounts (
  user_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

-- Only random token identifiers/hashes are stored, never bearer credentials.
CREATE TABLE auth_access_tokens (
  token_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_access_tokens_session_idx ON auth_access_tokens (session_id);

CREATE TABLE auth_refresh_tokens (
  token_hash char(64) PRIMARY KEY,
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_refresh_tokens_session_idx ON auth_refresh_tokens (session_id);

-- Keys are keyed digests, not plaintext email addresses or IP addresses.
CREATE TABLE auth_rate_limits (
  key char(64) PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_limits_reset_idx ON auth_rate_limits (reset_at);
