CREATE TABLE conversations (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation_participants (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id, conversation_id);
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id text NOT NULL,
  sender_id text NOT NULL,
  body text NOT NULL CHECK (length(body) > 0),
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_conversation_sender_fk FOREIGN KEY (conversation_id, sender_id)
    REFERENCES conversation_participants (conversation_id, user_id) ON DELETE CASCADE,
  CONSTRAINT messages_sender_idempotency_unique UNIQUE (sender_id, idempotency_key)
);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at, id);
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  event_key text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_user_event_unique UNIQUE (user_id, event_key)
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC, id);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events (available_at, created_at) WHERE delivered_at IS NULL;
CREATE TABLE revoked_sessions (
  session_id text PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX revoked_sessions_expiry_idx ON revoked_sessions (expires_at);
