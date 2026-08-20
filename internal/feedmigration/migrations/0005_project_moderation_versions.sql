ALTER TABLE feed.projects
  ADD COLUMN risk_override_eligible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN admin_removed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN projection_version BIGINT NOT NULL DEFAULT 1 CHECK (projection_version > 0);

CREATE TABLE feed.project_moderation_actions (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('risk_override', 'remove', 'restore')),
  enabled BOOLEAN,
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  projection_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(btrim(operator)) > 0),
  CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX project_moderation_actions_repo_time
  ON feed.project_moderation_actions (repo_key, created_at DESC);
