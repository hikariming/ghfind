CREATE TABLE feed.jobs (
 event_id TEXT PRIMARY KEY,
 payload JSONB NOT NULL,
 payload_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','leased','completed','dead_letter')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_owner TEXT,
 lease_until TIMESTAMPTZ,
 last_error TEXT,
 completed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feed_jobs_ready ON feed.jobs(status,available_at,event_id);
CREATE INDEX feed_jobs_expired ON feed.jobs(lease_until,event_id) WHERE status='leased';
ALTER TABLE feed.project_submission_evidence ADD COLUMN source_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE feed.project_submission_evidence ADD COLUMN source_event_id TEXT NOT NULL DEFAULT '';
ALTER TABLE feed.project_submission_evidence ADD COLUMN analysis_id TEXT NOT NULL DEFAULT '';
CREATE TABLE feed.tag_proposal_commands (
 github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
 command_id TEXT NOT NULL,
 proposal_id TEXT NOT NULL REFERENCES feed.tag_proposals(id),
 payload_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(github_id,command_id)
);
