CREATE TABLE article_likes (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, user_id)
);
CREATE INDEX article_likes_user_created_idx ON article_likes (user_id, created_at DESC);

CREATE TABLE article_comments (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_id text NOT NULL,
  parent_comment_id uuid REFERENCES article_comments(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX article_comments_article_created_idx ON article_comments (article_id, created_at, id);
CREATE INDEX article_comments_parent_created_idx ON article_comments (parent_comment_id, created_at, id);
