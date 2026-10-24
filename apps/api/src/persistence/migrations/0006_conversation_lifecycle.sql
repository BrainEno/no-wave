ALTER TABLE conversations ADD COLUMN created_by text;
ALTER TABLE conversation_participants ADD COLUMN left_at timestamptz;
ALTER TABLE conversation_participants ADD COLUMN last_read_at timestamptz;

-- Establish a baseline for existing memberships so historic messages do not all
-- appear unread as soon as the read receipt feature is introduced.
UPDATE conversation_participants SET last_read_at = now() WHERE last_read_at IS NULL;

CREATE INDEX conversation_participants_active_user_idx
  ON conversation_participants (user_id, conversation_id)
  WHERE left_at IS NULL;
