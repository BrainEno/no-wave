-- The reference an image lives or dies by, materialized (issue #163).
--
-- Until now "is this image used?" was answered by reading every work's
-- `content_blocks` — every author, every state, every locale — into Node on each
-- media-library request, and matching a regex in memory. At two thousand works
-- that is megabytes of JSON per page view; at twenty thousand it is a stall in
-- the main thread, and the page only ever asked about the twenty-four images in
-- front of the reader.
--
-- This table is that answer, kept current by the same transactions that write the
-- bodies: one row per (asset, work, locale) the body mentions. The library then
-- asks `WHERE asset_id = ANY(...)` for its page and never reads a body at all.
--
-- Why a table and not a narrower scan: the scan's job is to be *right*, and its
-- right answer is "nothing on the platform points at this". Narrowing it would
-- silently decide that some references do not count, and the cost of that
-- decision is somebody's published work full of broken images. Materializing
-- costs storage and a migration; being wrong costs data.
--
-- `locale` is part of the key because a work has one body per language, and a
-- reference in the translation nobody is reading is still a reference: deleting
-- the image would break that locale, not this one.
--
-- The foreign keys are the point of the table under concurrency. `ON DELETE
-- CASCADE` on the work means purging a tombstone takes its references with it;
-- `ON DELETE RESTRICT` on the asset means the database itself refuses to remove an
-- image a body points at, even if a caller forgot to ask. That is the second line
-- of defence behind the row-lock protocol in `lockMediaAssetReferences` (#156):
-- the lock makes the check race-free, and this constraint makes it final.

CREATE TABLE article_media_refs (
  asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale text NOT NULL,
  PRIMARY KEY (asset_id, article_id, locale)
);

-- The library's query direction: given this page's assets, what references them.
CREATE INDEX article_media_refs_article_idx ON article_media_refs (article_id, locale);

/**
 * Backfill the existing bodies.
 *
 * A body reaches this table through its `src` fields — the shape both editors
 * write — and every address form resolves to the same suffix: `/api/media/<id>`
 * (the Web relay), `/api/v1/media/<id>` (the API's own route, which a direct
 * client such as the Flutter app stored), and an absolute URL around either.
 *
 * Declared dependencies rather than a nested subquery on purpose: this is a
 * recursive walk of every top-level block and of the children of each one, and
 * naming the default list makes PostgreSQL evaluate it once instead of once per
 * block. Each UUID is inserted at most once per (asset, work, locale) because of
 * the primary key, so a body that uses the same image twice cannot fail the
 * migration.
 */
INSERT INTO article_media_refs (asset_id, article_id, locale)
SELECT DISTINCT found.id, found.article_id, found.locale
  FROM (
    SELECT (m.reference)[1]::uuid AS id, t.article_id, t.locale
      FROM article_translations AS t,
           LATERAL jsonb_path_query(
             t.content_blocks,
             'strict $.**.src ? (@ like_regex "/media/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")'
           ) AS src(value)
     CROSS JOIN LATERAL regexp_matches(src.value #>> '{}', '/media/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})') AS m(reference)
     WHERE jsonb_typeof(src.value) = 'string'
       AND EXISTS (SELECT 1 FROM media_assets AS a WHERE a.id = (m.reference)[1]::uuid)
  ) AS found
ON CONFLICT DO NOTHING;

-- The avatar is a media reference that lives in no body (issue #146 found it, and
-- it is why the scan reads `user_profiles` at all). It is one value per profile,
-- so it gets a column rather than a row: a column can carry an index, and an
-- indexed equality is what turns "who uses this image" into a lookup.
ALTER TABLE user_profiles ADD COLUMN avatar_media_id uuid;

UPDATE user_profiles
   SET avatar_media_id = (regexp_matches(avatar_url, '/media/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})'))[1]::uuid
 WHERE avatar_url IS NOT NULL
   AND avatar_url ~ '/media/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
   AND EXISTS (
     SELECT 1 FROM media_assets AS a
      WHERE a.id = (regexp_matches(avatar_url, '/media/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})'))[1]::uuid
   );

CREATE INDEX user_profiles_avatar_media_idx ON user_profiles (avatar_media_id) WHERE avatar_media_id IS NOT NULL;
