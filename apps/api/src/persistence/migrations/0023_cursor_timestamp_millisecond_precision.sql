-- Cursor pagination compares a JS `Date.toISOString()` millisecond string with
-- PostgreSQL `timestamptz` values. `now()` carries microseconds, so a row that
-- falls inside the same millisecond as a truncated cursor is greater than the
-- cursor and disappears from every later page.
--
-- Normalize legacy rows, then make defaults and CHECK constraints enforce the
-- same precision for future writes. The existing B-tree indexes stay usable:
-- they index the raw columns, which now agree exactly with the cursor strings.
UPDATE articles
SET published_at = date_trunc('milliseconds', published_at)
WHERE published_at IS NOT NULL
  AND published_at <> date_trunc('milliseconds', published_at);

UPDATE media_assets
SET created_at = date_trunc('milliseconds', created_at)
WHERE created_at <> date_trunc('milliseconds', created_at);

ALTER TABLE articles
  ALTER COLUMN published_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE media_assets
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE articles
  ADD CONSTRAINT articles_published_at_millisecond_precision
  CHECK (published_at IS NULL OR published_at = date_trunc('milliseconds', published_at));

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_created_at_millisecond_precision
  CHECK (created_at = date_trunc('milliseconds', created_at));
