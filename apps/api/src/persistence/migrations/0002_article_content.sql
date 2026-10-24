CREATE TABLE articles (
  id uuid PRIMARY KEY,
  author_id text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX articles_author_updated_idx ON articles (author_id, updated_at DESC, id);
CREATE INDEX articles_published_idx ON articles (published_at DESC, id) WHERE status = 'published';

CREATE TABLE article_translations (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('zh-TW', 'en')),
  title text NOT NULL CHECK (length(title) > 0),
  summary text NOT NULL DEFAULT '',
  content_blocks jsonb NOT NULL CHECK (jsonb_typeof(content_blocks) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, locale)
);
CREATE INDEX article_translations_locale_title_idx ON article_translations (locale, title);
