-- Messages and mark-all used to compare wall-clock timestamps. A later write
-- can share a millisecond with the mark, or the clock can move backwards.
-- Upgrade only with writers stopped and no in-progress provider capture: the
-- backfill is not a journaled domain transaction.
CREATE TEMP TABLE conversation_read_order_capture_guard (active_count INTEGER);
CREATE TEMP TRIGGER conversation_read_order_capture_guard_check
BEFORE INSERT ON conversation_read_order_capture_guard WHEN NEW.active_count <> 0
BEGIN SELECT RAISE(ABORT, 'Finish or abort active provider migration sessions before upgrading conversation read order'); END;
INSERT INTO conversation_read_order_capture_guard
SELECT count(*) FROM provider_migration_sessions
WHERE status IN ('prepared', 'recording', 'backfilling', 'catching_up');
DROP TABLE conversation_read_order_capture_guard;

ALTER TABLE conversations ADD COLUMN last_message_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (last_message_sequence >= 0 AND last_message_sequence <= 9007199254740991);
ALTER TABLE conversation_participants ADD COLUMN last_read_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (last_read_sequence >= 0 AND last_read_sequence <= 9007199254740991);
ALTER TABLE messages ADD COLUMN conversation_sequence INTEGER;

-- Reproduce the old ordering and old unread predicate exactly for existing
-- rows. Equal legacy timestamps were already indistinguishable; the backfill
-- cannot infer whether one of them arrived just after a previous mark.
CREATE TEMP TABLE conversation_read_order_backfill AS
SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS sequence
FROM messages;
CREATE UNIQUE INDEX conversation_read_order_backfill_id ON conversation_read_order_backfill(id);
UPDATE messages SET conversation_sequence = (
  SELECT sequence FROM conversation_read_order_backfill WHERE id = messages.id
);
DROP TABLE conversation_read_order_backfill;

UPDATE conversations SET last_message_sequence = COALESCE(
  (SELECT max(conversation_sequence) FROM messages WHERE conversation_id = conversations.id), 0
);
UPDATE conversation_participants SET last_read_sequence = COALESCE(
  (SELECT max(m.conversation_sequence) FROM messages AS m
   WHERE m.conversation_id = conversation_participants.conversation_id
     AND m.created_at <= conversation_participants.last_read_at), 0
);
CREATE UNIQUE INDEX messages_conversation_sequence_idx ON messages (conversation_id, conversation_sequence);

-- SQLite cannot add a NOT NULL column without a default to a populated table.
-- These guards enforce the same invariant for future inserts and updates and
-- reject old binaries that would otherwise silently create unsequenced rows.
CREATE TRIGGER messages_require_conversation_sequence_insert
BEFORE INSERT ON messages
WHEN NEW.conversation_sequence IS NULL OR typeof(NEW.conversation_sequence) <> 'integer'
  OR NEW.conversation_sequence < 1 OR NEW.conversation_sequence > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'message conversation sequence is required'); END;
CREATE TRIGGER messages_require_conversation_sequence_update
BEFORE UPDATE OF conversation_sequence ON messages
WHEN NEW.conversation_sequence IS NULL OR typeof(NEW.conversation_sequence) <> 'integer'
  OR NEW.conversation_sequence < 1 OR NEW.conversation_sequence > 9007199254740991
BEGIN SELECT RAISE(ABORT, 'message conversation sequence is required'); END;
