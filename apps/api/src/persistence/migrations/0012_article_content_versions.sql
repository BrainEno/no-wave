-- Version article content independently from the transport and editor library.
-- Existing rows remain version 0 and are readable without a data rewrite.
ALTER TABLE article_translations
  ADD COLUMN content_blocks_version integer NOT NULL DEFAULT 0
  CHECK (content_blocks_version IN (0, 1));
