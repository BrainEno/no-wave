-- Refuse an ambiguous legacy database without deleting or reassigning rows.
-- Migration execution is transactional, so the check and triggers are atomic.
CREATE TEMP TABLE external_content_owner_check (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO external_content_owner_check (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM external_content_links GROUP BY provider, external_id
  HAVING count(DISTINCT owner_id) > 1
) THEN 0 ELSE 1 END;
DROP TABLE external_content_owner_check;

CREATE TRIGGER external_content_owner_insert BEFORE INSERT ON external_content_links
WHEN EXISTS (
  SELECT 1 FROM external_content_links
  WHERE provider = NEW.provider AND external_id = NEW.external_id AND owner_id <> NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'The Notion page is already linked to another work or account.');
END;

CREATE TRIGGER external_content_owner_update BEFORE UPDATE OF provider, external_id, owner_id ON external_content_links
WHEN EXISTS (
  SELECT 1 FROM external_content_links
  WHERE provider = NEW.provider AND external_id = NEW.external_id AND owner_id <> NEW.owner_id
    AND NOT (provider = OLD.provider AND external_id = OLD.external_id AND locale = OLD.locale)
)
BEGIN
  SELECT RAISE(ABORT, 'The Notion page is already linked to another work or account.');
END;
