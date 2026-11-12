-- A page has one owner regardless of edition. An exclusion constraint, unlike a
-- trigger that queries the table, arbitrates concurrent transactions as well as
-- direct SQL writes. Existing contradictory rows make the migration fail rather
-- than silently choosing an owner or discarding anyone's provenance.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE external_content_links ADD CONSTRAINT external_content_links_page_owner_excl
  EXCLUDE USING gist (provider WITH =, external_id WITH =, owner_id WITH <>);
