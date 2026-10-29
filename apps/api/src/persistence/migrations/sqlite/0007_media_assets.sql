-- SQLite counterpart for portable asset metadata. Bytes live in external S3-compatible storage.
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
  width INTEGER NOT NULL CHECK (width > 0 AND width <= 2560),
  height INTEGER NOT NULL CHECK (height > 0 AND height <= 2560),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX media_assets_owner_created_idx ON media_assets (owner_id, created_at DESC, id DESC);
