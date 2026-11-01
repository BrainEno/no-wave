-- ADR 0016: the public taxonomy and the featured shelf are editorial, so the
-- platform needs to be able to say who an editor is. One column, two values:
-- `member` publishes, `editor` additionally curates.
--
-- Existing rows default to `member`, so no account gains a privilege by being
-- migrated. The environment list `EDITOR_USER_IDS` is what gets an editor into an
-- empty database; see ADR 0016, decision 2.
ALTER TABLE user_profiles
  ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor'));
