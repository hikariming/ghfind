CREATE TABLE IF NOT EXISTS feed_cleanup_jobs (
  deletion_id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_floor INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','failed','completed')),
  phase TEXT NOT NULL CHECK(phase IN ('primary','archive','semantic','completed')),
  primary_table INTEGER NOT NULL DEFAULT 0,
  archive_cursor TEXT,
  archive_scan_done INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0 AND failures<=8),
  claims INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  transition_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_cleanup_jobs_ready ON feed_cleanup_jobs(status,available_at);
CREATE INDEX IF NOT EXISTS idx_feed_cleanup_jobs_expired ON feed_cleanup_jobs(status,lease_until);
INSERT INTO feed_cleanup_jobs(deletion_id,github_id,profile_floor,requested_at,status,phase,available_at,updated_at)
  SELECT id,github_id,profile_floor,requested_at,'pending','primary',requested_at,requested_at
  FROM feed_profile_deletions WHERE status<>'completed' ON CONFLICT(deletion_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS feed_archive_objects (
  object_key TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','stored','erased')),
  created_at INTEGER NOT NULL,
  erased_at INTEGER,
  retain_marker_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feed_archive_objects_user ON feed_archive_objects(github_id,profile_version,status,object_key);
CREATE TABLE IF NOT EXISTS feed_archive_guards (
  id TEXT PRIMARY KEY,
  writer_ok INTEGER NOT NULL CONSTRAINT writer_epoch_changed CHECK(writer_ok=1),
  profile_ok INTEGER NOT NULL CONSTRAINT profile_version_changed CHECK(profile_ok=1),
  payload_ok INTEGER NOT NULL CONSTRAINT archive_id_conflict CHECK(payload_ok=1)
);
CREATE TABLE IF NOT EXISTS feed_cleanup_policy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  semantic_mode TEXT NOT NULL CHECK(semantic_mode IN ('disabled','required'))
);
INSERT INTO feed_cleanup_policy VALUES(1,'disabled') ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS feed_operator_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('sourceEvent','deletion')),
  target_id TEXT NOT NULL,
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action='replay'),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_operator_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT replay_not_allowed CHECK(valid=1)
);
CREATE TABLE IF NOT EXISTS feed_user_proposal_authors (
  proposal_id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  redacted_at INTEGER
);
UPDATE feed_runtime_control SET schema_version=5 WHERE id=1 AND schema_version=4;
