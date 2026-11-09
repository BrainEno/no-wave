-- The inbox pages by `(created_at DESC, id DESC)` and the client builds the next
-- cursor from `createdAt` in the response, which is a JavaScript
-- `Date.toISOString()` — milliseconds only. Migration 0023 made that safe for
-- works and media; notifications were left at `now()`'s microsecond precision.
--
-- The failure is silent and one-directional: a cursor naming `…:00.123Z` is
-- compared with stored values like `…:00.123456Z`, which are *greater* than the
-- cursor, so every notification inside the boundary millisecond sorts above it
-- and is never returned. Older pages simply end early.
--
-- Normalize existing rows, then make the default and a CHECK constraint hold the
-- same precision for future writes. The B-tree index
-- `notifications_user_created_idx (user_id, created_at DESC, id)` indexes the raw
-- column, which now agrees exactly with the cursor string, so the keyset
-- comparison stays an index range scan.
UPDATE notifications
SET created_at = date_trunc('milliseconds', created_at)
WHERE created_at <> date_trunc('milliseconds', created_at);

ALTER TABLE notifications
  ALTER COLUMN created_at SET DEFAULT date_trunc('milliseconds', now());

ALTER TABLE notifications
  ADD CONSTRAINT notifications_created_at_millisecond_precision
  CHECK (created_at = date_trunc('milliseconds', created_at));
