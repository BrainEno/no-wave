-- The two account transitions self-hosted identity is missing: proving an address
-- belongs to its owner, and letting an owner back in after a forgotten password.
--
-- One table serves both, because both are the same thing: a single-use, expiring,
-- purpose-scoped bearer of "this request was made by whoever received the mail".
-- Only the digest of the token is stored, exactly as refresh credentials are —
-- a dump of this table must not let anyone reset a password.
ALTER TABLE auth_accounts
  ADD COLUMN email_verified_at timestamptz;

CREATE TABLE auth_identity_tokens (
  token_hash char(64) PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('password_reset', 'email_verification')),
  -- The address the token was issued for, so a reset redeemed after an address
  -- change cannot be used to claim the new one, and so the mail has a recipient
  -- without another join.
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX auth_identity_tokens_user_purpose_idx
  ON auth_identity_tokens (user_id, purpose);
CREATE INDEX auth_identity_tokens_expiry_idx
  ON auth_identity_tokens (expires_at);
