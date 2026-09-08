-- Additive runtime-v1 state; never infer submission consent from an assessment.
-- IF NOT EXISTS + conflict-safe seeds make a retried migration harmless.
CREATE TABLE IF NOT EXISTS feed_runtime_control (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  schema_version INTEGER NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK(writer_epoch > 0),
  writes_enabled INTEGER NOT NULL CHECK(writes_enabled IN (0, 1))
);
INSERT INTO feed_runtime_control VALUES (1, 3, 1, 1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS feed_submission_provenance (
  repo_key TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('user_submission', 'owner_submission', 'verified_historical')),
  evidence_ref TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feed_provenance_analysis ON feed_submission_provenance(repo_key, analysis_id, revoked_at);

-- Assertions inserted and deleted within a D1 batch cause any failed command
-- to roll back as one transaction. Named CHECK constraints map to wire errors.
CREATE TABLE IF NOT EXISTS feed_command_guards (
  id TEXT PRIMARY KEY,
  writer_ok INTEGER NOT NULL CONSTRAINT writer_epoch_changed CHECK(writer_ok = 1),
  profile_ok INTEGER NOT NULL CONSTRAINT profile_version_changed CHECK(profile_ok = 1),
  taxonomy_ok INTEGER NOT NULL CONSTRAINT taxonomy_version_changed CHECK(taxonomy_ok = 1),
  relation_ok INTEGER NOT NULL CONSTRAINT project_not_found CHECK(relation_ok = 1),
  payload_ok INTEGER NOT NULL CONSTRAINT idempotency_conflict CHECK(payload_ok = 1)
);
CREATE TABLE IF NOT EXISTS feed_profile_floors (
  github_id INTEGER PRIMARY KEY,
  profile_floor INTEGER NOT NULL CHECK(profile_floor >= 1),
  deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_runtime_sessions (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at AND expires_at <= created_at + 1800000)
);
CREATE INDEX IF NOT EXISTS idx_feed_runtime_session_user ON feed_runtime_sessions(github_id, expires_at);
CREATE TABLE IF NOT EXISTS feed_runtime_requests (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  seed TEXT NOT NULL,
  candidate_counts_json TEXT NOT NULL CHECK(json_valid(candidate_counts_json)),
  degraded_json TEXT NOT NULL CHECK(json_valid(degraded_json)),
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_runtime_requests_retention ON feed_runtime_requests(created_at);
CREATE TABLE IF NOT EXISTS feed_runtime_served_metadata (
  request_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  candidate_sources_json TEXT NOT NULL CHECK(json_valid(candidate_sources_json)),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json)),
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  score REAL NOT NULL,
  PRIMARY KEY(request_id, repo_key)
);
CREATE TABLE IF NOT EXISTS feed_runtime_events (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  repo_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('impression','detail_open','dwell','github_outbound','share','save','unsave','not_interested','undo_not_interested')),
  occurred_at INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  duration_ms INTEGER,
  qualified INTEGER NOT NULL DEFAULT 0 CHECK(qualified IN (0,1)),
  state_value INTEGER CHECK(state_value IN (0,1)),
  payload_hash TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_runtime_events_user ON feed_runtime_events(github_id, repo_key, type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_feed_runtime_events_command ON feed_runtime_events(command_id);
CREATE TABLE IF NOT EXISTS feed_behavior_signals (
  github_id INTEGER NOT NULL,
  repo_key TEXT NOT NULL,
  signal TEXT NOT NULL CHECK(signal IN ('saved','outbound','qualified_dwell')),
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY(github_id, repo_key, signal)
);
CREATE TABLE IF NOT EXISTS feed_runtime_outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  profile_version INTEGER,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','completed','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_runtime_outbox_ready ON feed_runtime_outbox(status, available_at);
CREATE TABLE IF NOT EXISTS feed_profile_deletions (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_floor INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','failed','completed')),
  primary_complete INTEGER NOT NULL DEFAULT 0,
  archive_complete INTEGER NOT NULL DEFAULT 0,
  semantic_complete INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT,
  CHECK(status != 'completed' OR (primary_complete = 1 AND archive_complete = 1 AND semantic_complete = 1))
);
CREATE INDEX IF NOT EXISTS idx_feed_profile_deletions_user ON feed_profile_deletions(github_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_projects_runtime_latest ON feed_projects(published, analyzed_at DESC, repo_key);
CREATE INDEX IF NOT EXISTS idx_feed_projects_runtime_longtail ON feed_projects(published, treasure_eligible, exposure_band, analyzed_at DESC, repo_key);
