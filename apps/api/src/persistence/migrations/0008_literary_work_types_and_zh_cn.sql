ALTER TABLE articles
  ADD COLUMN work_type text NOT NULL DEFAULT 'other'
  CHECK (work_type IN ('novel', 'short_story', 'poetry', 'essay', 'criticism', 'literary_criticism', 'nonfiction', 'serial', 'other'));

ALTER TABLE article_translations DROP CONSTRAINT article_translations_locale_check;
ALTER TABLE article_translations ADD CONSTRAINT article_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en'));
ALTER TABLE taxonomy_translations DROP CONSTRAINT taxonomy_translations_locale_check;
ALTER TABLE taxonomy_translations ADD CONSTRAINT taxonomy_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en'));
ALTER TABLE user_profile_translations DROP CONSTRAINT user_profile_translations_locale_check;
ALTER TABLE user_profile_translations ADD CONSTRAINT user_profile_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en'));

-- Preserve existing authored text exactly. zh-CN records are locale-compatible
-- copies until authors or editors provide a reviewed Simplified Chinese edition.
INSERT INTO article_translations (article_id, locale, title, summary, content_blocks, created_at, updated_at)
SELECT article_id, 'zh-CN', title, summary, content_blocks, created_at, updated_at
FROM article_translations WHERE locale = 'zh-TW'
ON CONFLICT (article_id, locale) DO NOTHING;

INSERT INTO taxonomy_translations (taxonomy_id, locale, name, description, created_at, updated_at)
SELECT taxonomy_id, 'zh-CN', name, description, created_at, updated_at
FROM taxonomy_translations WHERE locale = 'zh-TW'
ON CONFLICT (taxonomy_id, locale) DO NOTHING;

INSERT INTO user_profile_translations (user_id, locale, display_name, bio, created_at, updated_at)
SELECT user_id, 'zh-CN', display_name, bio, created_at, updated_at
FROM user_profile_translations WHERE locale = 'zh-TW'
ON CONFLICT (user_id, locale) DO NOTHING;
