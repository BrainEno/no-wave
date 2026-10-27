-- SQLite remains an opt-in adapter; old/pending events are kept intact.
ALTER TABLE outbox_events ADD COLUMN lease_token TEXT;
