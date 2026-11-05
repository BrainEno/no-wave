-- The sequence transition backfills existing data without producing domain
-- journal entries. Stop all old writers and finish/abort active capture before
-- this migration; take a new version-matched snapshot afterwards.
LOCK TABLE conversations, conversation_participants, messages, provider_migration_sessions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_migration_sessions WHERE status IN ('prepared', 'recording', 'backfilling', 'catching_up')) THEN
    RAISE EXCEPTION 'Finish or abort active provider migration sessions before upgrading conversation read order';
  END IF;
END $$;

ALTER TABLE conversations ADD COLUMN last_message_sequence bigint NOT NULL DEFAULT 0
  CHECK (last_message_sequence >= 0 AND last_message_sequence <= 9007199254740991);
ALTER TABLE conversation_participants ADD COLUMN last_read_sequence bigint NOT NULL DEFAULT 0
  CHECK (last_read_sequence >= 0 AND last_read_sequence <= 9007199254740991);
ALTER TABLE messages ADD COLUMN conversation_sequence bigint;

-- The old unread predicate depends only on created_at. Sorting existing rows by
-- that field and id preserves each participant's pre-upgrade read count; equal
-- legacy timestamps cannot reveal which side of a prior mark a write occupied.
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS sequence
  FROM messages
)
UPDATE messages SET conversation_sequence = ordered.sequence FROM ordered WHERE messages.id = ordered.id;
UPDATE conversations SET last_message_sequence = COALESCE(
  (SELECT max(conversation_sequence) FROM messages WHERE conversation_id = conversations.id), 0
);
UPDATE conversation_participants SET last_read_sequence = COALESCE(
  (SELECT max(m.conversation_sequence) FROM messages AS m
   WHERE m.conversation_id = conversation_participants.conversation_id
     AND m.created_at <= conversation_participants.last_read_at), 0
);
ALTER TABLE messages ALTER COLUMN conversation_sequence SET NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_sequence_positive
  CHECK (conversation_sequence > 0 AND conversation_sequence <= 9007199254740991);
CREATE UNIQUE INDEX messages_conversation_sequence_idx ON messages (conversation_id, conversation_sequence);
