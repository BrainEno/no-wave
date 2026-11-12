-- The runner's BEGIN IMMEDIATE serializes legacy validation, trigger creation
-- and migration history with every writer. Fail without changing provenance.
CREATE TEMP TABLE external_content_owner_validation (valid INTEGER);
CREATE TEMP TRIGGER external_content_owner_legacy_check
BEFORE INSERT ON external_content_owner_validation
WHEN EXISTS (
  SELECT 1 FROM external_content_links GROUP BY provider, external_id
  HAVING count(DISTINCT owner_id) > 1
)
BEGIN
  SELECT RAISE(ABORT, 'Conflicting Notion page ownership; see docs/architecture/decisions/0037-import-provenance.md before retrying.');
END;
INSERT INTO external_content_owner_validation (valid) VALUES (1);
DROP TABLE external_content_owner_validation;

-- SQLite's single writer makes these checks authoritative for direct DML too.
-- The stable marker is translated only with SQLITE_CONSTRAINT_TRIGGER (1811).
CREATE TRIGGER external_content_owner_insert BEFORE INSERT ON external_content_links
WHEN EXISTS (
  SELECT 1 FROM external_content_links
  WHERE provider = NEW.provider AND external_id = NEW.external_id AND owner_id <> NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'external_content_links_page_owner_conflict');
END;

CREATE TRIGGER external_content_owner_update
BEFORE UPDATE OF provider, external_id, owner_id ON external_content_links
WHEN EXISTS (
  SELECT 1 FROM external_content_links
  WHERE provider = NEW.provider AND external_id = NEW.external_id AND owner_id <> NEW.owner_id
    AND NOT (provider = OLD.provider AND external_id = OLD.external_id AND locale = OLD.locale)
)
BEGIN
  SELECT RAISE(ABORT, 'external_content_links_page_owner_conflict');
END;
