-- Store only hashed caller keys and request fingerprints; never retain the raw
-- Idempotency-Key. Scoped per creator, so a retry reopens the conversation it
-- already created instead of a second one next to it.
ALTER TABLE conversations
  ADD COLUMN idempotency_key_hash TEXT
    CHECK (idempotency_key_hash IS NULL OR (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE conversations
  ADD COLUMN request_hash TEXT
    CHECK (request_hash IS NULL OR (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'));

CREATE UNIQUE INDEX conversations_creator_idempotency_key_idx
  ON conversations (created_by, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
