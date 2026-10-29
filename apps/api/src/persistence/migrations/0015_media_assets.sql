-- Publicly addressable media metadata; bytes live in an S3-compatible object store.
-- Only normalized WebP output is persisted. Source uploads are never retained.
CREATE TABLE media_assets (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_accounts(user_id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type = 'image/webp'),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
  width integer NOT NULL CHECK (width > 0 AND width <= 2560),
  height integer NOT NULL CHECK (height > 0 AND height <= 2560),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_owner_created_idx ON media_assets (owner_id, created_at DESC, id DESC);
