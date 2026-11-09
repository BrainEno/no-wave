-- Search the whole body, not just the prose blocks (#245).
--
-- Migration 0027 materialised `$[*].text` — the prose of paragraphs, headings
-- and quotes — so a body search could be answered by a trigram index. It left
-- two things out, and both are text a reader wrote and would search for: the
-- `items` of a list block and the `code` of a code block. A technical work whose
-- only mention of a term sat inside a snippet or a bullet was unfindable, which
-- is precisely the work someone searches for.
--
-- The column has to be dropped and re-added: PostgreSQL refuses to change a
-- generation expression in place, and the value is derived, so nothing is lost
-- beyond the seconds the rewrite takes. Rows are recomputed as the column is
-- added.
--
-- What is still *not* searched is the block's own vocabulary — the JSON keys
-- (`text`, `items`, `code`, `type`, …). The arrays are serialised by
-- `jsonb_path_query_array`, which collects values only, so a search for
-- "paragraph" still finds nothing. The contract test pins that.
--
-- The trigram index goes with the column it indexed; 0027 created it and this
-- migration recreates it, so the predicate the store sends is indexable again.
ALTER TABLE article_translations
  DROP COLUMN IF EXISTS content_search_text;

ALTER TABLE article_translations
  ADD COLUMN content_search_text text
  GENERATED ALWAYS AS (
    jsonb_path_query_array(COALESCE(content_blocks, '[]'::jsonb), '$[*].text')::text
    || ' ' ||
    jsonb_path_query_array(COALESCE(content_blocks, '[]'::jsonb), '$[*].items[*]')::text
    || ' ' ||
    jsonb_path_query_array(COALESCE(content_blocks, '[]'::jsonb), '$[*].code')::text
  ) STORED;

CREATE INDEX IF NOT EXISTS article_translations_content_search_trgm_idx
  ON article_translations USING gin (content_search_text gin_trgm_ops);
