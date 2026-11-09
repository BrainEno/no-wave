-- The same column as PostgreSQL migration 0032: a work's reach, kept on the row
-- so a page of works costs no extra read.
--
-- SQLite applies `CHECK` to every insert and update (a table-level constraint
-- added by `ALTER TABLE` would not be re-validated against existing rows, but
-- the default makes them all zero anyway).
ALTER TABLE articles
  ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0);
