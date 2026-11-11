-- A work-wide change counter for future import conflict checks. It is deliberately
-- separate from timestamps and view counts. No importer consumes it yet.
ALTER TABLE articles ADD COLUMN import_revision bigint NOT NULL DEFAULT 0 CHECK (import_revision >= 0);

CREATE FUNCTION bump_article_import_revision_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.import_revision := OLD.import_revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER article_import_revision_work BEFORE UPDATE OF slug, status, work_type, deleted_at, published_at ON articles
FOR EACH ROW EXECUTE FUNCTION bump_article_import_revision_work();

CREATE FUNCTION bump_article_import_revision_child() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE articles SET import_revision = import_revision + 1 WHERE id = OLD.article_id;
  END IF;
  IF TG_OP = 'INSERT' THEN
    UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.article_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.article_id IS DISTINCT FROM OLD.article_id THEN
    UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.article_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER article_import_revision_translation AFTER INSERT OR UPDATE OR DELETE ON article_translations
FOR EACH ROW EXECUTE FUNCTION bump_article_import_revision_child();
CREATE TRIGGER article_import_revision_taxonomy AFTER INSERT OR UPDATE OR DELETE ON article_taxonomies
FOR EACH ROW EXECUTE FUNCTION bump_article_import_revision_child();
