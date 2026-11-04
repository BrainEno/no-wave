-- Which media each work actually uses, materialised (#163) — PostgreSQL
-- counterpart of sqlite/0015. The reasoning is stated once there; what differs
-- is noted here: jsonb needs an explicit ::text before it can be pattern
-- matched, and the nullable avatar column is added with IF NOT EXISTS so this
-- file stays re-runnable in the way 0003 and friends are.
--
-- `asset_id` is `text`, not `uuid`, because `media_assets.id` is `text` (see
-- 0015_media_assets.sql — the id is the storage-naming key, not a uuid drawn by
-- the database). A uuid column here would fail the foreign key outright.
CREATE TABLE article_media_refs (
  asset_id text NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale text NOT NULL,
  PRIMARY KEY (asset_id, article_id, locale)
);

CREATE INDEX article_media_refs_article_idx
  ON article_media_refs (article_id, locale);

-- Backfill with the same rule the old scan used: the asset's id appears in a
-- `/media/<id>` path somewhere in this body. `content_blocks::text` is the jsonb
-- rendering, which keeps the array's quotes and escaping — the id and its path
-- prefix are unaffected by either, since both are plain ASCII inside a string.
INSERT INTO article_media_refs (asset_id, article_id, locale)
SELECT DISTINCT m.id, t.article_id, t.locale
FROM media_assets m
JOIN article_translations t
  ON lower(t.content_blocks::text) LIKE '%/media/' || lower(m.id) || '%'
ON CONFLICT DO NOTHING;

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS avatar_media_id text
  REFERENCES media_assets(id) ON DELETE SET NULL;

-- A correlated subquery rather than `UPDATE ... FROM LATERAL`: the lateral form
-- cannot reference the row being updated, and an inner join on a single match
-- would silently drop profiles whose avatar resolves to nothing.
UPDATE user_profiles
SET avatar_media_id = (
  SELECT m.id
  FROM media_assets m
  WHERE lower(user_profiles.avatar_url) LIKE '%/media/' || lower(m.id) || '%'
  LIMIT 1
)
WHERE user_profiles.avatar_url IS NOT NULL AND user_profiles.avatar_url <> '';

CREATE INDEX IF NOT EXISTS user_profiles_avatar_media_idx
  ON user_profiles (avatar_media_id);
