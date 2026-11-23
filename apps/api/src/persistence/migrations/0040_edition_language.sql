-- Notion 导入的英文作品改标为英文版本（en），让中文首页只列中文作品、英文首页只列英文作品。
--
-- Every public listing already selects one locale's editions. The importer,
-- however, labelled each Notion page that is not the target of another page's
-- `English` relation as zh-CN, so an author's standalone English work sat on the
-- Chinese home and was missing from the English one. The importer now labels
-- such a page by the language it is written in (apps/api/src/domain/
-- edition-language.ts); this backfill applies exactly that rule, once, to the
-- editions earlier imports wrote — the same rule as SQLite 0027:
--
--   * the edition is zh-CN and was written by a Notion import — it has a
--     zh-CN Notion link to the same work. Editions written in the desk keep the
--     locale their author chose;
--   * no Han, kana or hangul character in its title, summary or any string in
--     its blocks (jsonb's text form carries the characters themselves);
--   * at least one Latin letter in its title, summary, or a block's top-level
--     `text`, `attribution`, `caption`, `alt` or list `items`;
--   * the work has no en edition yet, and the page has no en link — a work
--     cannot have two English editions.
--
-- The edition's Notion link and media references move with it, so a re-import
-- finds the page in the locale it now plans for and an in-use image stays
-- protected. The 0034 trigger bumps import_revision, which invalidates
-- outstanding import previews — correct, the work's editions did change.
--
-- The backfill is not a journaled domain transaction: finish or abort any
-- provider capture first, as 0026 requires.
LOCK TABLE article_translations, article_media_refs, external_content_links, provider_migration_sessions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_migration_sessions WHERE status IN ('prepared', 'recording', 'backfilling', 'catching_up')) THEN
    RAISE EXCEPTION 'Finish or abort active provider migration sessions before relabelling edition languages';
  END IF;
END $$;

CREATE TEMP TABLE edition_language_relabel ON COMMIT DROP AS
SELECT t.article_id
FROM article_translations t
WHERE t.locale = 'zh-CN'
  AND EXISTS (
    SELECT 1 FROM external_content_links l
    WHERE l.provider = 'notion' AND l.article_id = t.article_id AND l.locale = 'zh-CN'
  )
  AND NOT EXISTS (SELECT 1 FROM article_translations e WHERE e.article_id = t.article_id AND e.locale = 'en')
  AND NOT EXISTS (
    SELECT 1 FROM external_content_links l
    JOIN external_content_links e ON e.provider = l.provider AND e.external_id = l.external_id AND e.locale = 'en'
    WHERE l.provider = 'notion' AND l.article_id = t.article_id AND l.locale = 'zh-CN'
  )
  AND t.title !~ '[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]'
  AND coalesce(t.summary, '') !~ '[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]'
  AND t.content_blocks::text !~ '[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]'
  AND (
    t.title ~ '[A-Za-z]'
    OR coalesce(t.summary, '') ~ '[A-Za-z]'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(t.content_blocks) b(value)
      WHERE jsonb_typeof(b.value) = 'object' AND (
        (jsonb_typeof(b.value -> 'text') = 'string' AND b.value ->> 'text' ~ '[A-Za-z]')
        OR (jsonb_typeof(b.value -> 'attribution') = 'string' AND b.value ->> 'attribution' ~ '[A-Za-z]')
        OR (jsonb_typeof(b.value -> 'caption') = 'string' AND b.value ->> 'caption' ~ '[A-Za-z]')
        OR (jsonb_typeof(b.value -> 'alt') = 'string' AND b.value ->> 'alt' ~ '[A-Za-z]')
        OR (jsonb_typeof(b.value -> 'items') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(b.value -> 'items') i(value)
          WHERE jsonb_typeof(i.value) = 'string' AND i.value #>> '{}' ~ '[A-Za-z]'
        ))
      )
    )
  );

-- An en reference without an en edition is stale; drop it so the move cannot
-- collide with it.
DELETE FROM article_media_refs
WHERE locale = 'en' AND article_id IN (SELECT article_id FROM edition_language_relabel);
UPDATE article_media_refs SET locale = 'en'
WHERE locale = 'zh-CN' AND article_id IN (SELECT article_id FROM edition_language_relabel);
UPDATE external_content_links SET locale = 'en'
WHERE provider = 'notion' AND locale = 'zh-CN' AND article_id IN (SELECT article_id FROM edition_language_relabel);
UPDATE article_translations SET locale = 'en'
WHERE locale = 'zh-CN' AND article_id IN (SELECT article_id FROM edition_language_relabel);
