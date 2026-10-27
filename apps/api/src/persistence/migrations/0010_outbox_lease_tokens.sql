-- A nullable token lets upgraded workers fence stale claims without modifying
-- pending or already delivered events. Stop old workers before applying this.
ALTER TABLE outbox_events ADD COLUMN lease_token uuid;
