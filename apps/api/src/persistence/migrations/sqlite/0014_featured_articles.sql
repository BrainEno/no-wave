-- SQLite contract counterpart: an ordered editorial shelf, one row per work.
-- The reader list joins against published articles only, so a soft-deleted work
-- keeps its row and simply stops appearing.
CREATE TABLE featured_articles (
  article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX featured_articles_position_idx
  ON featured_articles (position, created_at);
