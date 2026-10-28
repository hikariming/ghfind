-- Independent social posts; project feed tables and X engagement metrics are not reused.
PRAGMA foreign_keys = ON;
CREATE TABLE social_feed_authors (
  id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE social_feed_accounts (
  user_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL UNIQUE REFERENCES social_feed_authors(id)
);
CREATE TABLE social_feed_x_accounts (
  x_user_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES social_feed_authors(id),
  evidence_url TEXT NOT NULL,
  evidence_method TEXT NOT NULL CHECK(evidence_method IN ('editorial_review','reciprocal_links')),
  evidence_checked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE social_feed_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES social_feed_authors(id),
  publisher_user_id TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('x','ghfind')),
  kind TEXT NOT NULL CHECK(kind IN ('original','reply')),
  conversation_id TEXT NOT NULL REFERENCES social_feed_posts(id) DEFERRABLE INITIALLY DEFERRED,
  parent_post_id TEXT REFERENCES social_feed_posts(id),
  text TEXT NOT NULL,
  x_media_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(x_media_json)),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','deleted','hidden')),
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_version INTEGER NOT NULL DEFAULT 1 CHECK(content_version >= 1),
  source_x_post_id TEXT UNIQUE,
  source_x_user_id TEXT REFERENCES social_feed_x_accounts(x_user_id),
  source_url TEXT,
  source_name TEXT,
  source_avatar_url TEXT,
  source_evidence_url TEXT,
  source_evidence_method TEXT,
  source_evidence_checked_at TEXT,
  source_eligible INTEGER NOT NULL DEFAULT 1 CHECK(source_eligible IN (0,1)),
  publication_score REAL NOT NULL CHECK(publication_score >= 60 AND publication_score <= 100),
  publication_score_record_id TEXT NOT NULL,
  publication_score_version TEXT NOT NULL,
  publication_policy_version TEXT NOT NULL,
  CHECK((kind='original' AND parent_post_id IS NULL AND conversation_id=id) OR
        (kind='reply' AND parent_post_id IS NOT NULL AND conversation_id<>id)),
  CHECK((origin='x' AND publisher_user_id IS NULL AND source_x_post_id IS NOT NULL AND
         source_x_user_id IS NOT NULL AND source_url IS NOT NULL AND source_name IS NOT NULL AND
         source_evidence_url IS NOT NULL AND source_evidence_method IN ('editorial_review','reciprocal_links') AND
         source_evidence_checked_at IS NOT NULL) OR
        (origin='ghfind' AND publisher_user_id IS NOT NULL AND source_x_post_id IS NULL AND
         source_x_user_id IS NULL AND source_url IS NULL AND source_name IS NULL AND
         source_avatar_url IS NULL AND source_evidence_url IS NULL AND source_evidence_method IS NULL AND
         source_evidence_checked_at IS NULL AND x_media_json='[]'))
);
CREATE INDEX social_feed_posts_timeline ON social_feed_posts(status, kind, published_at DESC, id DESC);
CREATE INDEX social_feed_posts_replies ON social_feed_posts(parent_post_id, published_at DESC, id DESC);
CREATE INDEX social_feed_posts_conversation ON social_feed_posts(conversation_id, published_at, id);
CREATE INDEX social_feed_posts_author ON social_feed_posts(author_id, published_at DESC, id DESC);
CREATE TABLE social_feed_x_versions (
  x_post_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  observed_at TEXT NOT NULL
);
CREATE TABLE social_feed_post_versions (
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  content_version INTEGER NOT NULL,
  text TEXT NOT NULL,
  media_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id, content_version)
);
CREATE TABLE social_feed_commands (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, idempotency_key)
);
CREATE TABLE social_feed_media_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  width INTEGER CHECK(width > 0),
  height INTEGER CHECK(height > 0),
  alt_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('ready','deleted')),
  created_at TEXT NOT NULL
);
CREATE TABLE social_feed_post_media (
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  media_id TEXT NOT NULL REFERENCES social_feed_media_assets(id),
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 3),
  PRIMARY KEY(post_id, media_id),
  UNIQUE(post_id, position)
);
CREATE TABLE social_feed_reactions (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  value TEXT NOT NULL CHECK(value IN ('like','dislike')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,post_id)
);
CREATE INDEX social_feed_reactions_post ON social_feed_reactions(post_id,value);
CREATE TABLE social_feed_bookmarks (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,post_id)
);
CREATE INDEX social_feed_bookmarks_user ON social_feed_bookmarks(user_id,created_at DESC,post_id DESC);
CREATE TABLE social_feed_reposts (
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,post_id)
);
CREATE INDEX social_feed_reposts_post ON social_feed_reposts(post_id);
CREATE TABLE social_feed_follows (
  user_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES social_feed_authors(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,author_id)
);
CREATE TABLE social_feed_views (
  actor_key TEXT NOT NULL,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  view_date TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_key,post_id,view_date)
);
CREATE INDEX social_feed_views_post ON social_feed_views(post_id);
CREATE TABLE social_feed_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  post_id TEXT REFERENCES social_feed_posts(id),
  actor_user_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);
CREATE INDEX social_feed_events_time ON social_feed_events(occurred_at,id);
-- Bounded delivery snapshots freeze activity order while deletions remain live.
CREATE TABLE social_feed_sessions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX social_feed_sessions_expiry ON social_feed_sessions(expires_at,id);
CREATE TABLE social_feed_session_items (
  session_id TEXT NOT NULL REFERENCES social_feed_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  sort_time TEXT NOT NULL,
  sort_id TEXT NOT NULL,
  reposter_author_id TEXT REFERENCES social_feed_authors(id),
  PRIMARY KEY(session_id,position),
  UNIQUE(session_id,post_id)
);
CREATE TABLE social_feed_quotas (
  actor_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count > 0),
  PRIMARY KEY(actor_key,operation,window_start)
);
CREATE TRIGGER social_feed_account_identity_guard BEFORE UPDATE ON social_feed_accounts
WHEN NEW.author_id<>OLD.author_id
BEGIN SELECT RAISE(ABORT,'source_conflict'); END;
CREATE TRIGGER social_feed_x_account_identity_guard BEFORE UPDATE ON social_feed_x_accounts
WHEN NEW.author_id<>OLD.author_id
BEGIN SELECT RAISE(ABORT,'source_conflict'); END;
CREATE TRIGGER social_feed_post_x_author_guard BEFORE INSERT ON social_feed_posts
WHEN NEW.origin='x' AND NOT EXISTS(
  SELECT 1 FROM social_feed_x_accounts account WHERE account.x_user_id=NEW.source_x_user_id AND account.author_id=NEW.author_id
)
BEGIN SELECT RAISE(ABORT,'source_conflict'); END;
CREATE TRIGGER social_feed_post_parent_guard BEFORE INSERT ON social_feed_posts
WHEN NEW.parent_post_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM social_feed_posts parent JOIN social_feed_posts root ON root.id=parent.conversation_id
    WHERE parent.id=NEW.parent_post_id AND parent.conversation_id=NEW.conversation_id
      AND parent.status='published' AND root.status='published'
      AND (NEW.origin='ghfind' OR (parent.origin='x' AND parent.author_id=NEW.author_id AND parent.source_x_user_id=NEW.source_x_user_id))
  ) THEN RAISE(ABORT,'invalid_reply_target') END;
END;
CREATE TRIGGER social_feed_post_identity_guard BEFORE UPDATE ON social_feed_posts
WHEN NEW.id<>OLD.id OR NEW.author_id<>OLD.author_id OR NEW.origin<>OLD.origin OR NEW.kind<>OLD.kind OR
  NEW.conversation_id<>OLD.conversation_id OR NEW.parent_post_id IS NOT OLD.parent_post_id OR
  NEW.publisher_user_id IS NOT OLD.publisher_user_id OR NEW.source_x_user_id IS NOT OLD.source_x_user_id OR
  NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable_post_identity'); END;
CREATE TRIGGER social_feed_command_guard BEFORE UPDATE ON social_feed_commands
WHEN NEW.payload_hash<>OLD.payload_hash
BEGIN SELECT RAISE(ABORT,'idempotency_conflict'); END;
CREATE TRIGGER social_feed_x_version_guard BEFORE INSERT ON social_feed_x_versions
WHEN NOT EXISTS(SELECT 1 FROM social_feed_posts WHERE id=NEW.post_id AND origin='x')
BEGIN SELECT RAISE(ABORT,'invalid_x_source'); END;
CREATE TRIGGER social_feed_x_version_identity_guard BEFORE UPDATE ON social_feed_x_versions
WHEN NEW.post_id<>OLD.post_id
BEGIN SELECT RAISE(ABORT,'source_conflict'); END;
CREATE TRIGGER social_feed_media_guard BEFORE INSERT ON social_feed_post_media
WHEN NOT EXISTS(
 SELECT 1 FROM social_feed_posts p JOIN social_feed_media_assets m ON m.id=NEW.media_id
 WHERE p.id=NEW.post_id AND p.origin='ghfind' AND p.publisher_user_id=m.owner_user_id AND m.status='ready'
)
BEGIN SELECT RAISE(ABORT,'invalid_media'); END;
CREATE TRIGGER social_feed_post_created AFTER INSERT ON social_feed_posts BEGIN
  INSERT INTO social_feed_post_versions VALUES(NEW.id,NEW.content_version,NEW.text,NEW.x_media_json,NEW.created_at);
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),
    CASE WHEN NEW.kind='reply' THEN 'reply_created' ELSE 'post_created' END,
    NEW.id,NEW.publisher_user_id,json_object('origin',NEW.origin,'content_version',NEW.content_version),NEW.created_at);
END;
CREATE TRIGGER social_feed_post_revised AFTER UPDATE OF text,x_media_json ON social_feed_posts
WHEN NEW.text<>OLD.text OR NEW.x_media_json<>OLD.x_media_json BEGIN
  INSERT INTO social_feed_post_versions VALUES(NEW.id,NEW.content_version,NEW.text,NEW.x_media_json,NEW.updated_at);
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'post_edited',NEW.id,NEW.publisher_user_id,
    json_object('content_version',NEW.content_version),NEW.updated_at);
END;
CREATE TRIGGER social_feed_post_status_changed AFTER UPDATE OF status ON social_feed_posts
WHEN NEW.status<>OLD.status BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'post_status_changed',NEW.id,NEW.publisher_user_id,
    json_object('status',NEW.status),NEW.updated_at);
END;
CREATE TRIGGER social_feed_reactions_insert AFTER INSERT ON social_feed_reactions BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'reaction_changed',NEW.post_id,NEW.user_id,
    json_object('post_id',NEW.post_id,'active',1,'value',NEW.value),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_reactions_delete AFTER DELETE ON social_feed_reactions BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'reaction_changed',OLD.post_id,OLD.user_id,
    json_object('post_id',OLD.post_id,'active',0,'value',OLD.value),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_reactions_target_guard BEFORE INSERT ON social_feed_reactions
WHEN NOT EXISTS(SELECT 1 FROM social_feed_posts p JOIN social_feed_posts root ON root.id=p.conversation_id
 WHERE p.id=NEW.post_id AND p.status='published' AND root.status<>'hidden')
BEGIN SELECT RAISE(ABORT,'post_not_available'); END;
CREATE TRIGGER social_feed_bookmarks_insert AFTER INSERT ON social_feed_bookmarks BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'bookmark_changed',NEW.post_id,NEW.user_id,
    json_object('post_id',NEW.post_id,'active',1),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_bookmarks_delete AFTER DELETE ON social_feed_bookmarks BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'bookmark_changed',OLD.post_id,OLD.user_id,
    json_object('post_id',OLD.post_id,'active',0),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_bookmarks_target_guard BEFORE INSERT ON social_feed_bookmarks
WHEN NOT EXISTS(SELECT 1 FROM social_feed_posts p JOIN social_feed_posts root ON root.id=p.conversation_id
 WHERE p.id=NEW.post_id AND p.status='published' AND root.status<>'hidden')
BEGIN SELECT RAISE(ABORT,'post_not_available'); END;
CREATE TRIGGER social_feed_reposts_insert AFTER INSERT ON social_feed_reposts BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'repost_changed',NEW.post_id,NEW.user_id,
    json_object('post_id',NEW.post_id,'active',1),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_reposts_delete AFTER DELETE ON social_feed_reposts BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'repost_changed',OLD.post_id,OLD.user_id,
    json_object('post_id',OLD.post_id,'active',0),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_reposts_target_guard BEFORE INSERT ON social_feed_reposts
WHEN NOT EXISTS(SELECT 1 FROM social_feed_posts p JOIN social_feed_posts root ON root.id=p.conversation_id
 WHERE p.id=NEW.post_id AND p.status='published' AND root.status<>'hidden')
BEGIN SELECT RAISE(ABORT,'post_not_available'); END;
CREATE TRIGGER social_feed_follows_insert AFTER INSERT ON social_feed_follows BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'follow_changed',NULL,NEW.user_id,
    json_object('author_id',NEW.author_id,'active',1),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_follows_delete AFTER DELETE ON social_feed_follows BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'follow_changed',NULL,OLD.user_id,
    json_object('author_id',OLD.author_id,'active',0),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER social_feed_reactions_update AFTER UPDATE OF value ON social_feed_reactions
WHEN NEW.value<>OLD.value BEGIN
  INSERT INTO social_feed_events VALUES(lower(hex(randomblob(16))),'reaction_changed',NEW.post_id,NEW.user_id,
    json_object('value',NEW.value,'previous_value',OLD.value),NEW.updated_at);
END;
CREATE TRIGGER social_feed_view_recorded AFTER INSERT ON social_feed_views BEGIN
  INSERT INTO social_feed_events VALUES(NEW.event_id,'qualified_view',NEW.post_id,NULL,
    json_object('view_date',NEW.view_date),NEW.created_at);
END;
