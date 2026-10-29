-- Store only hashed caller keys and request fingerprints; never retain the raw Idempotency-Key.
ALTER TABLE article_comments
  ADD COLUMN idempotency_key_hash TEXT
    CHECK (idempotency_key_hash IS NULL OR (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE article_comments
  ADD COLUMN request_hash TEXT
    CHECK (request_hash IS NULL OR (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'));

CREATE UNIQUE INDEX article_comments_author_idempotency_key_idx
  ON article_comments (author_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
