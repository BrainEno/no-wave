-- SQLite contract counterpart: one column, two values, existing rows stay members.
ALTER TABLE user_profiles
  ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor'));
