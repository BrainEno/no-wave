-- Accelerate case-insensitive substring search over public article text.
-- pg_trgm supports ILIKE patterns with leading/trailing wildcards.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS article_translations_title_trgm_idx
  ON article_translations USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS article_translations_summary_trgm_idx
  ON article_translations USING gin (summary gin_trgm_ops);
