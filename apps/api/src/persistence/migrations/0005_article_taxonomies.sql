CREATE TABLE taxonomies (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('category', 'tag')),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, slug)
);
CREATE TABLE taxonomy_translations (
  taxonomy_id uuid NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('zh-TW', 'en')),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (taxonomy_id, locale)
);
CREATE TABLE article_taxonomies (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  taxonomy_id uuid NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, taxonomy_id)
);
CREATE INDEX taxonomy_translations_locale_name_idx ON taxonomy_translations (locale, name);
CREATE INDEX article_taxonomies_taxonomy_article_idx ON article_taxonomies (taxonomy_id, article_id);
