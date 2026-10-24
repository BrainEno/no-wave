CREATE TABLE user_profiles (
  user_id text PRIMARY KEY,
  avatar_url text,
  website_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_profile_translations (
  user_id text NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('zh-TW', 'en')),
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  bio text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, locale)
);
CREATE INDEX user_profile_translations_locale_name_idx ON user_profile_translations (locale, display_name);
