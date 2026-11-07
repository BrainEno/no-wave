-- See the PostgreSQL migration of the same subject: a marker, not a revision log.
ALTER TABLE article_comments ADD COLUMN edited_at TEXT;
