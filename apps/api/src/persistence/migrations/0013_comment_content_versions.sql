-- Add versioned rich comment documents without rewriting legacy plain-text comments.
ALTER TABLE article_comments
  ADD COLUMN content_blocks jsonb,
  ADD COLUMN content_blocks_version integer NOT NULL DEFAULT 0
    CHECK (content_blocks_version IN (0, 1)),
  ADD CONSTRAINT article_comments_content_document_contract CHECK (
    (content_blocks_version = 0 AND content_blocks IS NULL)
    OR
    (content_blocks_version = 1
      AND CASE
        WHEN jsonb_typeof(content_blocks) = 'array'
          THEN jsonb_array_length(content_blocks) BETWEEN 1 AND 20
        ELSE false
      END)
  );
