-- The same table as PostgreSQL migration 0033 (ADR 0037): which Notion page each
-- imported edition came from, so a re-import updates instead of duplicating.
--
-- SQLite has no `uuid` type and stores timestamps as the millisecond ISO strings
-- the rest of this schema uses, so the columns are named and typed to match what
-- the provider-migration journal already carries.
CREATE TABLE external_content_links (
  provider TEXT NOT NULL CHECK (provider IN ('notion')),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'zh-TW', 'en')),
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  digest TEXT NOT NULL CHECK (length(digest) BETWEEN 1 AND 64),
  synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider, external_id, locale)
);
CREATE INDEX external_content_links_owner_idx ON external_content_links (owner_id, provider);
CREATE INDEX external_content_links_article_idx ON external_content_links (article_id);
