-- Local to this database: a provider cutover invalidates outstanding import plans.
CREATE TABLE import_plan_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT NOT NULL CHECK (length(generation) = 32)
);
INSERT INTO import_plan_generation (singleton, generation) VALUES (1, lower(hex(randomblob(16))));

-- SQLite promotes an overflowing INTEGER addition to REAL instead of raising
-- like PostgreSQL bigint. Refuse that promotion: two rounded revisions must
-- never compare equal after distinct writes. Valid int64 values remain exact.
CREATE TRIGGER article_import_revision_integer_insert BEFORE INSERT ON articles
WHEN typeof(NEW.import_revision) != 'integer'
BEGIN
  SELECT RAISE(ABORT, 'Article import revision must remain an exact integer.');
END;
CREATE TRIGGER article_import_revision_integer_update BEFORE UPDATE OF import_revision ON articles
WHEN typeof(NEW.import_revision) != 'integer'
BEGIN
  SELECT RAISE(ABORT, 'Article import revision must remain an exact integer.');
END;
