-- Stop an in-use image from being deleted, in the database (#156) — PostgreSQL
-- counterpart of sqlite/0016. The reasoning is stated once there; PostgreSQL
-- needs none of the table rebuilding, because a constraint can be replaced in
-- place.
--
-- Two directions have to be closed, and only the first was closed before:
--   * a work body that names the asset (`article_media_refs`)
--   * a profile that shows it as an avatar (`user_profiles.avatar_media_id`)
-- The avatar direction was `ON DELETE SET NULL`, so a delete succeeded and
-- quietly blanked someone's picture.

ALTER TABLE article_media_refs DROP CONSTRAINT article_media_refs_asset_id_fkey;
ALTER TABLE article_media_refs
  ADD CONSTRAINT article_media_refs_asset_id_fkey
  FOREIGN KEY (asset_id) REFERENCES media_assets(id) ON DELETE RESTRICT;

ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_avatar_media_id_fkey;
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_avatar_media_id_fkey
  FOREIGN KEY (avatar_media_id) REFERENCES media_assets(id) ON DELETE RESTRICT;
