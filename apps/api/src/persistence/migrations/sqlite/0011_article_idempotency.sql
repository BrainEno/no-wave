-- A retried create used to publish a second copy under a uniquified slug, so the
-- caller's key is recorded (hashed, scoped per author) and a retry returns the
-- work it already made. Optional: the desk does not send one yet.
ALTER TABLE articles
  ADD COLUMN idempotency_key_hash TEXT
    CHECK (idempotency_key_hash IS NULL OR (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE articles
  ADD COLUMN request_hash TEXT
    CHECK (request_hash IS NULL OR (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'));

CREATE UNIQUE INDEX articles_author_idempotency_key_idx
  ON articles (author_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
