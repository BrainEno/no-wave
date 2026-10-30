-- Opening a conversation is the one create left with no replay protection: a
-- retried POST /api/v1/conversations (a flaky connection, an impatient second
-- click) used to leave the same two people with two conversations, and the older
-- one silently stops receiving anything.
--
-- As with article comments, only a digest of the caller's key is ever stored —
-- clients are free to put an e-mail address or an internal identifier in an
-- Idempotency-Key, and the database should not end up holding it. The key is
-- scoped to the creator, so two different callers may reuse the same string
-- without colliding, and the stored request fingerprint lets a reused key with a
-- *different* body be answered with a conflict instead of a wrong replay.
ALTER TABLE conversations
  ADD COLUMN idempotency_key_hash text
    CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE conversations
  ADD COLUMN request_hash text
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX conversations_creator_idempotency_key_idx
  ON conversations (created_by, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
