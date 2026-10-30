-- The SQLite half of 0017: the tombstone column for a deleted work.
--
-- Timestamps are stored as ISO-8601 text in this schema, matching `published_at`.
-- Deletion continues to set `status = 'draft'`, so published reads exclude the row
-- without needing to mention the tombstone. See 0017 for the reasoning.
ALTER TABLE articles
  ADD COLUMN deleted_at TEXT;
