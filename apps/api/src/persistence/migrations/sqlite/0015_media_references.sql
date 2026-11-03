-- SQLite counterpart of `0024_media_references.sql` (issue #163).
--
-- The same materialized answer, for the same reason: the media library must not
-- read every work's body to ask about twenty-four images. Three provider
-- differences shape the SQLite version.
--
-- First, `node:sqlite` has no regex function, so an address is recognised by its
-- length instead of its shape: `substr(text, instr(lower(text), '/media/') + 7,
-- 36)` takes exactly one canonical UUID after the marker. That is what
-- `MEDIA_SRC_PATTERN` matches too — 8-4-4-4-12, case-insensitive — minus the hex
-- character classes, so a malformed tail is stored and simply matches no asset,
-- which cannot make a live reference disappear.
--
-- Second, a body's images are the `src` of a block or of one of its children,
-- and SQLite has no path query, so the walk is two `json_each`s over the top
-- level and `$.children`. Anything deeper is covered by the runtime extraction
-- on the writer path, and by the full scan as the backstop.
--
-- Third, SQLite cannot add a foreign key to an existing table, so the "the
-- database refuses to orphan an image" half of the protocol lives in the triggers
-- at the bottom rather than in a constraint. They are deliberately *abort*
-- triggers: a body may not point at an asset that does not exist, and an asset
-- may not be deleted while any body points at it.

CREATE TABLE article_media_refs (
  asset_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  PRIMARY KEY (asset_id, article_id, locale)
);

CREATE INDEX article_media_refs_article_idx ON article_media_refs (article_id, locale);
CREATE INDEX article_media_refs_asset_idx ON article_media_refs (asset_id);

WITH candidates AS (
  -- A block's own image (`src` on the block)...
  SELECT t.article_id, t.locale, json_extract(block.value, '$.src') AS src
    FROM article_translations AS t, json_each(t.content_blocks) AS block
   WHERE json_type(block.value, '$.src') = 'text'
  UNION ALL
  -- ...and the images its children carry (an image inside a paragraph).
  SELECT t.article_id, t.locale, json_extract(child.value, '$.src')
    FROM article_translations AS t,
         json_each(t.content_blocks) AS block,
         json_each(block.value, '$.children') AS child
   WHERE json_type(child.value, '$.src') = 'text'
)
INSERT OR IGNORE INTO article_media_refs (asset_id, article_id, locale)
SELECT DISTINCT
       lower(substr(c.src, instr(lower(c.src), '/media/') + 7, 36)),
       c.article_id,
       c.locale
  FROM candidates AS c
 WHERE instr(lower(c.src), '/media/') > 0
   AND length(substr(c.src, instr(lower(c.src), '/media/') + 7, 36)) = 36
   AND EXISTS (
     SELECT 1 FROM media_assets AS a
      WHERE a.id = lower(substr(c.src, instr(lower(c.src), '/media/') + 7, 36))
   );

CREATE TRIGGER article_media_refs_asset_exists
BEFORE INSERT ON article_media_refs
FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM media_assets WHERE id = NEW.asset_id)
BEGIN
  SELECT RAISE(ABORT, 'article_media_refs: unknown media asset');
END;

CREATE TRIGGER media_assets_refuse_referenced_delete
BEFORE DELETE ON media_assets
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM article_media_refs WHERE asset_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'media_assets: still referenced by a work');
END;

-- The avatar is a media reference that lives in no body (issue #146). One value
-- per profile, so it is a column and can carry an index.
ALTER TABLE user_profiles ADD COLUMN avatar_media_id TEXT;

UPDATE user_profiles
   SET avatar_media_id = lower(substr(avatar_url, instr(lower(avatar_url), '/media/') + 7, 36))
 WHERE avatar_url IS NOT NULL
   AND instr(lower(avatar_url), '/media/') > 0
   AND length(substr(avatar_url, instr(lower(avatar_url), '/media/') + 7, 36)) = 36
   AND EXISTS (
     SELECT 1 FROM media_assets AS a
      WHERE a.id = lower(substr(avatar_url, instr(lower(avatar_url), '/media/') + 7, 36))
   );

CREATE INDEX user_profiles_avatar_media_idx ON user_profiles (avatar_media_id) WHERE avatar_media_id IS NOT NULL;
