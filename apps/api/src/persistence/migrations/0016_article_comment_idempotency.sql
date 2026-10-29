-- Store a digest of the caller's key and a request fingerprint, never the raw key.
ALTER TABLE article_comments
  ADD COLUMN idempotency_key_hash text
    CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE article_comments
  ADD COLUMN request_hash text
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX article_comments_author_idempotency_key_idx
  ON article_comments (author_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
