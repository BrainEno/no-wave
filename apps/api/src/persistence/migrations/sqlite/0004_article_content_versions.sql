-- Existing article content is version 0; rich text is introduced additively.
ALTER TABLE article_translations
  ADD COLUMN content_blocks_version INTEGER NOT NULL DEFAULT 0
  CHECK (content_blocks_version IN (0, 1));
