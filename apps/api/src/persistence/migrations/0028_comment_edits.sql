-- An author may correct their own comment (ADR 0031). `edited_at` is the fact a
-- reader needs — "this was changed after it was posted" — and nothing more: the
-- previous text is not kept, so there is no revision history to reconcile, no
-- second place a moderation decision would have to point at, and no growth in the
-- row for the common case of a comment nobody edits.
--
-- Nullable on purpose: every comment written before this migration is unchanged
-- and answers `editedAt: null`, and an edit never sets `created_at`, so thread
-- order survives a correction.
ALTER TABLE article_comments ADD COLUMN edited_at timestamptz;
