ALTER TABLE outbox_events ADD COLUMN dead_lettered_at timestamptz;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_terminal_state_check
  CHECK (dead_lettered_at IS NULL OR (delivered_at IS NULL AND lease_token IS NULL));
DROP INDEX outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox_events (available_at, created_at)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX outbox_dead_letter_idx ON outbox_events (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

-- Legacy randomized notification keys remain history, not a reason to notify again.
CREATE INDEX notifications_like_identity_idx
  ON notifications (user_id, (payload->>'articleId'), (payload->>'actorId'))
  WHERE payload->>'type' = 'article.liked';
CREATE INDEX notifications_follow_identity_idx
  ON notifications (user_id, (payload->>'followerId'))
  WHERE payload->>'type' = 'user.followed';
