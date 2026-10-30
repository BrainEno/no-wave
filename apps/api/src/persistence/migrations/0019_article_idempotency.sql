-- Publishing a work is the write an author is most likely to repeat: the POST
-- that creates it is the same click as the one that publishes it, and a retry
-- used to land on a *different* slug (the create path uniquifies a taken
-- address), quietly producing a second copy of the same work.
--
-- The key is optional here, unlike conversations: the authoring desk does not
-- send one yet, and requiring it would break every existing client. It is stored
-- the same way as everywhere else — a digest of the caller's key, scoped to the
-- author, plus a fingerprint so a reused key with a different work is a conflict
-- rather than a wrong replay.
ALTER TABLE articles
  ADD COLUMN idempotency_key_hash text
    CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE articles
  ADD COLUMN request_hash text
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX articles_author_idempotency_key_idx
  ON articles (author_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
