-- Deleting a work leaves the row in place.
--
-- A work carries comments, likes, taxonomy links and provider-migration history
-- that reference it, and an author who deletes something in anger should still be
-- able to have it restored by someone with database access. So deletion is a
-- tombstone: `deleted_at` marks the row, and the status is set back to 'draft' so
-- every existing `status = 'published'` read — public pages, search, feeds,
-- related works, liked lists — hides it without a predicate of its own.
--
-- No CHECK constraint is relaxed and no table is rebuilt, which is what makes this
-- the same one-line `ALTER TABLE` on SQLite and on PostgreSQL.
ALTER TABLE articles
  ADD COLUMN deleted_at timestamptz;
