-- ADR 0016, decision 4: the featured shelf is an ordered editorial decision, not
-- a set. A category is a bag you drop a work into; featured is a list, and the
-- order is the point — so it gets its own table with a position.
--
-- `created_by` and `created_at` are here because the one question an editorial
-- decision has to be able to answer is "who put this here, and when".
--
-- The primary key is the article: a work appears on the shelf at most once, so a
-- double-click cannot add a duplicate row that then needs reconciling. Deleting an
-- article for good takes its featured row with it. A *soft*-deleted work keeps its
-- row and simply stops being listed, because the reader list joins against
-- published articles only.
CREATE TABLE featured_articles (
  article_id uuid PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  position integer NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX featured_articles_position_idx
  ON featured_articles (position, created_at);
