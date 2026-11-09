-- The comment thread pages by `(created_at ASC, id ASC)` and the client builds
-- the next cursor from `createdAt` in the response, which is a JavaScript
-- `Date.toISOString()` — milliseconds only. Orders and media got this in 0023 and
-- notifications in 0030; `article_comments` was still defaulting to `now()`,
-- which is microseconds.
--
-- Without this, a cursor naming `…:00.123Z` is compared with stored values like
-- `…:00.123456Z`: the reply that sits inside the boundary millisecond is greater
-- than the cursor, so a page that continues *after* the cursor skips it — and the
-- ones before it are returned twice on the previous page. A thread would show
-- duplicated and missing comments, with no error anywhere.
--
-- Normalize existing rows, then make the default and a CHECK constraint hold the
-- same precision for future writes. `article_comments_article_created_idx` and
-- `article_comments_parent_created_idx` index the raw column, which now agrees
-- exactly with the cursor string.
UPDATE article_comments
SET created_at = date_trunc('milliseconds', created_at)
WHERE created_at <> date_trunc('milliseconds', created_at);

ALTER TABLE article_comments
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE article_comments
  ADD CONSTRAINT article_comments_created_at_millisecond_precision
  CHECK (created_at = date_trunc('milliseconds', created_at));
