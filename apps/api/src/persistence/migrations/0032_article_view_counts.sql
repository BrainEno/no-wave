-- A work's reach is a number its author can see, and until now the database had
-- nowhere to keep it. `view_count` is denormalised on purpose: every list that
-- shows a work (the feed, a taxonomy page, a profile, the desk) reads it, and a
-- count derived per row would put a `GROUP BY` behind each of them.
--
-- The column is only ever moved by `recordArticleView`, which increments it in
-- the same transaction as the one-per-reader-per-day token that authorised the
-- increment. The `CHECK` is the floor: a counter that can go negative is a
-- counter somebody will count down by accident.
ALTER TABLE articles
  ADD COLUMN view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0);
