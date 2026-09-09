-- This fence rejects pre-adapter legacy DML even if an old Worker request
-- survives the traffic switch. Activation is an explicit serialized release
-- operation after the Go-only paused gateway is actually active.
-- The context exists only within the adapter's atomic D1 batch; a concurrent
-- connection cannot observe it. It is not a long-lived lock or an identity RPC.
CREATE TABLE IF NOT EXISTS feed_adapter_write_fence (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
INSERT INTO feed_adapter_write_fence VALUES(1,0) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS feed_adapter_write_context (
  id INTEGER PRIMARY KEY CHECK(id=1),
  token TEXT NOT NULL CHECK(length(token)=36)
);
CREATE TRIGGER IF NOT EXISTS feed_taxonomy_versions_adapter_insert
BEFORE INSERT ON feed_taxonomy_versions
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_taxonomy_versions_adapter_update
BEFORE UPDATE ON feed_taxonomy_versions
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_taxonomy_versions_adapter_delete
BEFORE DELETE ON feed_taxonomy_versions
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_definitions_adapter_insert
BEFORE INSERT ON feed_tag_definitions
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_definitions_adapter_update
BEFORE UPDATE ON feed_tag_definitions
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_definitions_adapter_delete
BEFORE DELETE ON feed_tag_definitions
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_aliases_adapter_insert
BEFORE INSERT ON feed_tag_aliases
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_aliases_adapter_update
BEFORE UPDATE ON feed_tag_aliases
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_aliases_adapter_delete
BEFORE DELETE ON feed_tag_aliases
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_projects_adapter_insert
BEFORE INSERT ON feed_projects
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_projects_adapter_update
BEFORE UPDATE ON feed_projects
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_projects_adapter_delete
BEFORE DELETE ON feed_projects
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_project_moderation_adapter_insert
BEFORE INSERT ON feed_project_moderation
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_project_moderation_adapter_update
BEFORE UPDATE ON feed_project_moderation
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_project_moderation_adapter_delete
BEFORE DELETE ON feed_project_moderation
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_project_tags_adapter_insert
BEFORE INSERT ON feed_project_tags
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_project_tags_adapter_update
BEFORE UPDATE ON feed_project_tags
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_project_tags_adapter_delete
BEFORE DELETE ON feed_project_tags
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_proposals_adapter_insert
BEFORE INSERT ON feed_tag_proposals
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_proposals_adapter_update
BEFORE UPDATE ON feed_tag_proposals
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_tag_proposals_adapter_delete
BEFORE DELETE ON feed_tag_proposals
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_users_adapter_insert
BEFORE INSERT ON feed_users
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_users_adapter_update
BEFORE UPDATE ON feed_users
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_users_adapter_delete
BEFORE DELETE ON feed_users
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_user_tag_preferences_adapter_insert
BEFORE INSERT ON feed_user_tag_preferences
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_user_tag_preferences_adapter_update
BEFORE UPDATE ON feed_user_tag_preferences
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_user_tag_preferences_adapter_delete
BEFORE DELETE ON feed_user_tag_preferences
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_user_project_states_adapter_insert
BEFORE INSERT ON feed_user_project_states
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_user_project_states_adapter_update
BEFORE UPDATE ON feed_user_project_states
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_user_project_states_adapter_delete
BEFORE DELETE ON feed_user_project_states
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_events_adapter_insert
BEFORE INSERT ON feed_events
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_events_adapter_update
BEFORE UPDATE ON feed_events
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_events_adapter_delete
BEFORE DELETE ON feed_events
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_served_items_adapter_insert
BEFORE INSERT ON feed_served_items
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_served_items_adapter_update
BEFORE UPDATE ON feed_served_items
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_served_items_adapter_delete
BEFORE DELETE ON feed_served_items
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_rate_windows_adapter_insert
BEFORE INSERT ON feed_rate_windows
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_rate_windows_adapter_update
BEFORE UPDATE ON feed_rate_windows
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
CREATE TRIGGER IF NOT EXISTS feed_rate_windows_adapter_delete
BEFORE DELETE ON feed_rate_windows
WHEN (SELECT enabled FROM feed_adapter_write_fence WHERE id=1)=1
  AND NOT EXISTS(SELECT 1 FROM feed_adapter_write_context WHERE id=1)
BEGIN SELECT RAISE(ABORT,'legacy_feed_writer_fenced'); END;
-- Runtime transport control remains 7; physical schema is verified separately.
