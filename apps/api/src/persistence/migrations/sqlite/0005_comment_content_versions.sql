-- Keep legacy plain text as version 0; rich documents are additive and nullable.
ALTER TABLE article_comments
  ADD COLUMN content_blocks TEXT
    CHECK (content_blocks IS NULL OR (json_valid(content_blocks) AND json_type(content_blocks) = 'array'));
ALTER TABLE article_comments
  ADD COLUMN content_blocks_version INTEGER NOT NULL DEFAULT 0
    CHECK (content_blocks_version IN (0, 1));

CREATE TRIGGER article_comments_content_contract_insert
BEFORE INSERT ON article_comments
WHEN NOT (
  (NEW.content_blocks_version = 0 AND NEW.content_blocks IS NULL)
  OR
  (NEW.content_blocks_version = 1 AND
    CASE WHEN NEW.content_blocks IS NOT NULL AND json_type(NEW.content_blocks) = 'array'
      THEN json_array_length(NEW.content_blocks) BETWEEN 1 AND 20
      ELSE 0
    END)
)
BEGIN
  SELECT RAISE(ABORT, 'article comment content version mismatch');
END;

CREATE TRIGGER article_comments_content_contract_update
BEFORE UPDATE OF content_blocks, content_blocks_version ON article_comments
WHEN NOT (
  (NEW.content_blocks_version = 0 AND NEW.content_blocks IS NULL)
  OR
  (NEW.content_blocks_version = 1 AND
    CASE WHEN NEW.content_blocks IS NOT NULL AND json_type(NEW.content_blocks) = 'array'
      THEN json_array_length(NEW.content_blocks) BETWEEN 1 AND 20
      ELSE 0
    END)
)
BEGIN
  SELECT RAISE(ABORT, 'article comment content version mismatch');
END;
