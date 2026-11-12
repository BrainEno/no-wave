-- Locale identifies an edition, not a separate ownership namespace (ADR 0037).
-- Block all DML while checking legacy rows and installing the final authority.
-- The runner commits this DDL and its migration-history row in one transaction.
LOCK TABLE external_content_links IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM external_content_links GROUP BY provider, external_id
    HAVING count(DISTINCT owner_id) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting Notion page ownership; see docs/architecture/decisions/0037-import-provenance.md before retrying.'
      USING ERRCODE = '23514';
  END IF;
END $$;

-- Trusted extension: the migration role needs database/schema CREATE rights,
-- or an administrator must install it in public beforehand. Never auto-repair
-- contradictory ownership or replace this exclusion with a race-prone SELECT.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
ALTER TABLE external_content_links ADD CONSTRAINT external_content_links_page_owner_excl
  EXCLUDE USING gist (provider WITH =, external_id WITH =, owner_id WITH <>);
