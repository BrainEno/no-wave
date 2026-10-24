CREATE TABLE user_follows (
  follower_id text NOT NULL,
  followed_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT user_follows_no_self CHECK (follower_id <> followed_id)
);
CREATE INDEX user_follows_followed_created_idx ON user_follows (followed_id, created_at DESC);
CREATE INDEX user_follows_follower_created_idx ON user_follows (follower_id, created_at DESC);
