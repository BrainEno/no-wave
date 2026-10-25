-- SQLite counterpart to the current PostgreSQL domain schema.
-- Keep this migration SQLite-native; do not execute PostgreSQL migrations here.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  left_at TEXT,
  last_read_at TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id, conversation_id);
CREATE INDEX conversation_participants_active_user_idx
  ON conversation_participants (user_id, conversation_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) > 0),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (conversation_id, sender_id)
    REFERENCES conversation_participants (conversation_id, user_id) ON DELETE CASCADE,
  UNIQUE (sender_id, idempotency_key)
);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at, id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT,
  UNIQUE (user_id, event_key)
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  delivered_at TEXT
);
CREATE INDEX outbox_pending_idx ON outbox_events (available_at, created_at) WHERE delivered_at IS NULL;

CREATE TABLE revoked_sessions (
  session_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX revoked_sessions_expiry_idx ON revoked_sessions (expires_at);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE CHECK (
    length(slug) > 0 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'
  ),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  work_type TEXT NOT NULL DEFAULT 'other'
    CHECK (work_type IN ('novel', 'short_story', 'poetry', 'essay', 'criticism', 'literary_criticism', 'nonfiction', 'serial', 'other')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT
);
CREATE INDEX articles_author_updated_idx ON articles (author_id, updated_at DESC, id);
CREATE INDEX articles_published_idx ON articles (published_at DESC, id) WHERE status = 'published';

CREATE TABLE article_translations (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'zh-TW', 'en')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT NOT NULL DEFAULT '',
  content_blocks TEXT NOT NULL CHECK (json_valid(content_blocks) AND json_type(content_blocks) = 'array'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (article_id, locale)
);
CREATE INDEX article_translations_locale_title_idx ON article_translations (locale, title);

CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY,
  avatar_url TEXT,
  website_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE user_profile_translations (
  user_id TEXT NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'zh-TW', 'en')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  bio TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, locale)
);
CREATE INDEX user_profile_translations_locale_name_idx ON user_profile_translations (locale, display_name);

CREATE TABLE article_likes (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (article_id, user_id)
);
CREATE INDEX article_likes_user_created_idx ON article_likes (user_id, created_at DESC);

CREATE TABLE article_comments (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  parent_comment_id TEXT REFERENCES article_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 5000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX article_comments_article_created_idx ON article_comments (article_id, created_at, id);
CREATE INDEX article_comments_parent_created_idx ON article_comments (parent_comment_id, created_at, id);

CREATE TABLE taxonomies (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('category', 'tag')),
  slug TEXT NOT NULL CHECK (
    length(slug) > 0 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (kind, slug)
);

CREATE TABLE taxonomy_translations (
  taxonomy_id TEXT NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('zh-CN', 'zh-TW', 'en')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (taxonomy_id, locale)
);

CREATE TABLE article_taxonomies (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  taxonomy_id TEXT NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (article_id, taxonomy_id)
);
CREATE INDEX taxonomy_translations_locale_name_idx ON taxonomy_translations (locale, name);
CREATE INDEX article_taxonomies_taxonomy_article_idx ON article_taxonomies (taxonomy_id, article_id);

CREATE TABLE user_follows (
  follower_id TEXT NOT NULL,
  followed_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX user_follows_followed_created_idx ON user_follows (followed_id, created_at DESC);
CREATE INDEX user_follows_follower_created_idx ON user_follows (follower_id, created_at DESC);
