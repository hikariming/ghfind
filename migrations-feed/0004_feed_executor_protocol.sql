-- Lease state and exact verified core receipt kinds for the discrete executor.
CREATE TABLE IF NOT EXISTS feed_execution_jobs (
  event_id TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
  envelope_hash TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version>0),
  status TEXT NOT NULL CHECK(status IN ('pending','leased','completed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=8),
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feed_execution_jobs_ready ON feed_execution_jobs(status,available_at);
CREATE INDEX IF NOT EXISTS idx_feed_execution_jobs_lease ON feed_execution_jobs(status,lease_until);
CREATE TABLE IF NOT EXISTS feed_execution_guards (
  id TEXT PRIMARY KEY,
  writer_ok INTEGER NOT NULL CONSTRAINT writer_epoch_changed CHECK(writer_ok=1),
  identity_ok INTEGER NOT NULL CONSTRAINT source_identity_mismatch CHECK(identity_ok=1),
  lease_ok INTEGER NOT NULL CONSTRAINT job_lease_lost CHECK(lease_ok=1)
);
CREATE TABLE IF NOT EXISTS feed_project_source_versions (
  repo_key TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK(source_version>0),
  receipt_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('app_submission','agent_submission','verified_backfill')),
  submitted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  item_id TEXT NOT NULL,
  resolved_commit_sha TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  blocked_reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_projection_commands (
  id TEXT PRIMARY KEY,
  applied INTEGER NOT NULL CHECK(applied IN (0,1))
);
-- Keep user proposal provenance separate from preexisting assessment proposals,
-- whose unique key has no source discriminator. Existing reviews stay intact.
CREATE TABLE IF NOT EXISTS feed_user_tag_proposals (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK(source='user'),
  namespace TEXT NOT NULL CHECK(namespace IN ('domain','use_case','audience','artifact','stack','stage')),
  slug TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL CHECK(status IN ('proposed','mapped','rejected')),
  reviewed_by TEXT,
  review_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repo_key,analysis_id,namespace,slug)
);
CREATE TABLE IF NOT EXISTS feed_tag_proposal_commands (
  github_id INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(github_id,command_id)
);
CREATE TABLE IF NOT EXISTS feed_proposal_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT proposal_id_conflict CHECK(valid=1)
);
UPDATE feed_runtime_control SET schema_version=4 WHERE id=1 AND schema_version=3;
