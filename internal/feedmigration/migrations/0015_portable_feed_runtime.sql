-- Additive: no existing candidate is silently assigned submission provenance.
CREATE TABLE feed.runtime_control (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
 writer_epoch BIGINT NOT NULL CHECK (writer_epoch > 0),
 writes_enabled BOOLEAN NOT NULL DEFAULT true,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO feed.runtime_control(singleton,writer_epoch) VALUES(true,1);
CREATE TABLE feed.sessions (
 id TEXT PRIMARY KEY,
 github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
 profile_version BIGINT NOT NULL,
 snapshot JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes')
);
CREATE INDEX feed_sessions_expiry ON feed.sessions(expires_at);
CREATE INDEX feed_sessions_actor ON feed.sessions(github_id,expires_at);
CREATE TABLE feed.project_submission_evidence (
 repo_key TEXT PRIMARY KEY REFERENCES feed.projects(repo_key) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('app_submission','agent_submission','verified_backfill')),
 source_id TEXT NOT NULL CHECK(length(source_id)>0),
 submitted_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN profile_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN cleanup_status TEXT NOT NULL DEFAULT 'queued' CHECK(cleanup_status IN ('queued','running','failed','completed'));
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE feed.user_deletion_tombstones ADD COLUMN last_error TEXT;
CREATE INDEX feed_deletion_actor_version ON feed.user_deletion_tombstones(github_id,profile_version DESC);
ALTER TABLE feed.requests ADD COLUMN payload_hash TEXT;
