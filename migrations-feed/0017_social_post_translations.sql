-- Per-locale body text for social posts, keyed to the post's content_version.
-- Reads join only the current version, so an edit retires older translations
-- without deleting them (they stay as history next to social_feed_post_versions).
PRAGMA foreign_keys = ON;
ALTER TABLE social_feed_posts ADD COLUMN source_lang TEXT
  CHECK(source_lang IS NULL OR (length(source_lang) BETWEEN 2 AND 35 AND source_lang GLOB '[a-z][a-z]*'));
CREATE TABLE social_feed_post_translations (
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  content_version INTEGER NOT NULL CHECK(content_version >= 1),
  locale TEXT NOT NULL CHECK(locale IN ('zh','en','ja','ko','es','pt','id','vi','ar')),
  text TEXT NOT NULL,
  source_lang TEXT CHECK(source_lang IS NULL OR (length(source_lang) BETWEEN 2 AND 35 AND source_lang GLOB '[a-z][a-z]*')),
  model TEXT,
  provider TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(post_id, content_version, locale),
  FOREIGN KEY(post_id, content_version) REFERENCES social_feed_post_versions(post_id, content_version)
);
