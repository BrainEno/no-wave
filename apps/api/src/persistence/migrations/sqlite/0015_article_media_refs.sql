-- Which media each work actually uses, materialised (#163).
--
-- The media library used to answer "is this image an orphan?" by reading every
-- work body in every locale into memory and regex-scanning it: O(total site
-- text) per page open, which at 20k works is ~77 MiB of JSON for a page that
-- shows at most 24 images. This table is that scan done once, kept current by
-- the same transaction that writes a translation.
--
-- Only the identity of the reference is stored — (asset, article, locale) — and
-- nothing that belongs to the work or to the asset. Title, slug, status and
-- author are read by joining `articles` / `article_translations` at query time,
-- so a title edit does not have to be mirrored here and a stale row cannot show
-- a reader a title that no longer exists.
--
-- `ON DELETE CASCADE` from `articles`: a hard purge takes the references with
-- it. The reverse direction (an asset referenced by a live work) is *not* a
-- foreign key on purpose — the delete path is being switched off by #156, and
-- the `ON DELETE RESTRICT` that makes it safe belongs with the protocol in
-- that issue, not with this one.
CREATE TABLE article_media_refs (
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  PRIMARY KEY (asset_id, article_id, locale)
);

-- The library asks "who uses this asset"; the delete check asks the same. The
-- primary key already covers (asset_id, ...) so no separate index is needed for
-- that direction.
CREATE INDEX article_media_refs_article_idx
  ON article_media_refs (article_id, locale);

-- Backfill the existing corpus.
--
-- Written as a join rather than a JSON walk because migrations here are plain
-- SQL with no scripting hook, and because the match must be the *same* rule the
-- old scan used: "the asset's id appears in a `/media/<id>` path in this body".
-- A regex would be nicer, but the id is a UUID — matching the literal path
-- suffix is exactly as selective, and it errs in the safe direction (`#163`):
-- an over-match refuses a delete, an under-match would allow one.
--
-- The `LIKE` is on `lower(...)` because the stored URLs may carry either case
-- and the pattern in `MEDIA_SRC_PATTERN` is case-insensitive, so this has to be
-- too. `instr` is not used here for the same reason it cannot be: the path has a
-- leading slash that a bare `instr` would match anywhere.
INSERT INTO article_media_refs (asset_id, article_id, locale)
SELECT DISTINCT m.id, t.article_id, t.locale
FROM media_assets m
JOIN article_translations t
  ON lower(t.content_blocks) LIKE '%/media/' || lower(m.id) || '%'
ON CONFLICT DO NOTHING;

-- Avatars are references too, and they live in no body at all. They have no
-- article to point at, so they get their own column on the profile rather than a
-- row with a NULL article — a NULL in a primary key column would make the same
-- reference insertable twice. `avatar_media_id` is derived once here and kept
-- current by `upsertAuthorProfile`; `avatar_url` stays the source of truth for
-- what a reader sees.
ALTER TABLE user_profiles ADD COLUMN avatar_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL;

UPDATE user_profiles
SET avatar_media_id = (
  SELECT m.id
  FROM media_assets m
  WHERE lower(user_profiles.avatar_url) LIKE '%/media/' || lower(m.id) || '%'
  LIMIT 1
)
WHERE avatar_url IS NOT NULL AND avatar_url <> '';

CREATE INDEX user_profiles_avatar_media_idx ON user_profiles (avatar_media_id);
