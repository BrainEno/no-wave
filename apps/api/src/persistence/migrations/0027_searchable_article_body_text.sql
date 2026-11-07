-- Make the body half of article search indexable (audit F-23).
--
-- `listPublishedArticles` walked `content_blocks` in the query
-- (`jsonb_array_elements ... ->>'text' ILIKE $2`), one block at a time. An
-- expression over a set cannot use an index, so every body search scanned every
-- published translation of the locale and walked its JSON. Titles and summaries
-- were indexed for exactly this query in migration 0009; the body was the part
-- that stayed a full scan.
--
-- `content_search_text` materialises the text that search reads: the `text`
-- member of each block, values only, never the JSON keys — so a reader searching
-- "paragraph" still matches nothing, which is the property migration 0009's
-- comment and the contract test both protect.
--
-- It is a *generated* column rather than one the application writes, so it
-- cannot drift from `content_blocks` whichever path writes a translation
-- (create, update, provider-migration replay, a hand fix in psql). Existing rows
-- are filled as the column is added.
--
-- Two consequences of serialising the values, both narrower than the cost of the
-- scan this replaces:
--   * a term still cannot match across two blocks (one block at a time could not
--     match across them either);
--   * a term containing a double quote inside a single block is escaped in this
--     text and will not match, where the per-block compare would have found it.
ALTER TABLE article_translations
  ADD COLUMN IF NOT EXISTS content_search_text text
  GENERATED ALWAYS AS (
    jsonb_path_query_array(COALESCE(content_blocks, '[]'::jsonb), '$[*].text')::text
  ) STORED;

CREATE INDEX IF NOT EXISTS article_translations_content_search_trgm_idx
  ON article_translations USING gin (content_search_text gin_trgm_ops);
