-- Stop an in-use image from being deleted, in the database (#156).
--
-- Until now `DELETE /api/v1/me/media/:id` refused an in-use image by scanning
-- every work body on the site inside its transaction. That check is only as good
-- as the moment it reads: a concurrent save can add a reference the scan never
-- saw, and the delete then commits over a live image. The materialised reference
-- table (#163) makes the question cheap; `ON DELETE RESTRICT` makes it
-- impossible to get wrong, because the constraint is enforced by the same
-- statement that deletes rather than by a read that could go stale.
--
-- Only `article_media_refs` is rebuilt. `media_assets` is untouched, which
-- matters more than it looks: SQLite cannot alter a foreign key in place, and
-- rebuilding a referenced table requires `PRAGMA foreign_keys = OFF` — a pragma
-- that is a no-op inside the transaction this runner wraps every migration in.
-- Replacing the *child* table needs neither.
--
-- The rows are recomputed from the bodies rather than copied, so a body written
-- by a fixture or an older migration that never went through the writer is
-- still correct afterwards.
DROP TABLE IF EXISTS article_media_refs;

CREATE TABLE article_media_refs (
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  PRIMARY KEY (asset_id, article_id, locale)
);

CREATE INDEX article_media_refs_article_idx
  ON article_media_refs (article_id, locale);

INSERT INTO article_media_refs (asset_id, article_id, locale)
SELECT DISTINCT m.id, t.article_id, t.locale
FROM media_assets m
JOIN article_translations t
  ON lower(t.content_blocks) LIKE '%/media/' || lower(m.id) || '%'
ON CONFLICT DO NOTHING;

-- Avatars are the other way an asset can be in use, and they were not protected
-- at all: `avatar_media_id` is `ON DELETE SET NULL`, so deleting an image that
-- is someone's picture silently blanked the avatar. It has to be RESTRICT too.
--
-- `user_profiles` is referenced by `user_profile_translations`, so it cannot
-- simply be dropped — that would cascade the translations away. The rows are
-- moved out first and back after the swap, inside this migration's transaction,
-- so a failure at any point leaves the original rows in place.
CREATE TABLE user_profiles_new (
  user_id TEXT PRIMARY KEY,
  avatar_url TEXT,
  website_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor')),
  avatar_media_id TEXT REFERENCES media_assets(id) ON DELETE RESTRICT
);

INSERT INTO user_profiles_new (user_id, avatar_url, website_url, created_at, updated_at, role, avatar_media_id)
SELECT user_id, avatar_url, website_url, created_at, updated_at, role, avatar_media_id FROM user_profiles;

-- Park the translations, which must not be lost to the cascade on the drop below.
CREATE TEMP TABLE parked_profile_translations AS
SELECT user_id, locale, display_name, bio, created_at, updated_at FROM user_profile_translations;

DROP TABLE user_profiles;
ALTER TABLE user_profiles_new RENAME TO user_profiles;
CREATE INDEX user_profiles_avatar_media_idx ON user_profiles (avatar_media_id);

INSERT INTO user_profile_translations (user_id, locale, display_name, bio, created_at, updated_at)
SELECT user_id, locale, display_name, bio, created_at, updated_at FROM parked_profile_translations;
DROP TABLE parked_profile_translations;
