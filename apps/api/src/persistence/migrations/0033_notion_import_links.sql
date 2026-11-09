-- An imported work needs an identity that survives a re-import (ADR 0037).
--
-- Without this table the only way to answer "have I already imported this Notion
-- page?" is to guess from the title or the slug, and both are the author's to
-- change. The pair `(provider, external_id)` is the page; `locale` is the edition
-- of that page, because a work's translations arrive as separate pages.
--
-- `owner_id` is not decoration: it is the (*) rule. A link belongs to the account
-- that created it, so a second account cannot claim somebody else's Notion page
-- and overwrite the article behind it. `ON DELETE CASCADE` means deleting the
-- work also forgets where it came from — the link is not a backup.
--
-- `digest` is the fingerprint of what a reader would see. It is what makes a
-- re-import a no-op instead of a rewrite, and it lives here rather than in a
-- client's state file so every client agrees.
CREATE TABLE external_content_links (
  provider text NOT NULL CHECK (provider IN ('notion')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  locale text NOT NULL CHECK (locale IN ('zh-CN', 'zh-TW', 'en')),
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  owner_id text NOT NULL CHECK (length(owner_id) > 0),
  digest text NOT NULL CHECK (length(digest) BETWEEN 1 AND 64),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id, locale)
);
CREATE INDEX external_content_links_owner_idx ON external_content_links (owner_id, provider);
CREATE INDEX external_content_links_article_idx ON external_content_links (article_id);
