-- A work-wide change counter for future import conflict checks. It is deliberately
-- separate from timestamps and view counts. No importer consumes it yet.
ALTER TABLE articles ADD COLUMN import_revision INTEGER NOT NULL DEFAULT 0 CHECK (import_revision >= 0);

CREATE TRIGGER article_import_revision_work AFTER UPDATE OF slug, status, work_type, deleted_at, published_at ON articles
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.id;
END;
CREATE TRIGGER article_import_revision_translation_insert AFTER INSERT ON article_translations
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.article_id;
END;
CREATE TRIGGER article_import_revision_translation_update AFTER UPDATE ON article_translations
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = OLD.article_id;
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.article_id AND NEW.article_id != OLD.article_id;
END;
CREATE TRIGGER article_import_revision_translation_delete AFTER DELETE ON article_translations
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = OLD.article_id;
END;
CREATE TRIGGER article_import_revision_taxonomy_insert AFTER INSERT ON article_taxonomies
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.article_id;
END;
CREATE TRIGGER article_import_revision_taxonomy_update AFTER UPDATE ON article_taxonomies
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = OLD.article_id;
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = NEW.article_id AND NEW.article_id != OLD.article_id;
END;
CREATE TRIGGER article_import_revision_taxonomy_delete AFTER DELETE ON article_taxonomies
BEGIN
  UPDATE articles SET import_revision = import_revision + 1 WHERE id = OLD.article_id;
END;
