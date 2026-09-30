-- Background devscore scoring (collection contract). One row per
-- account and collection contract: re-enqueueing a finished or failed job
-- resets the same row, so there is never more than one active job per user.
-- `collect_state` is the collector's small resumable checkpoint; bulk data
-- lives in the DEVSCORE_CACHE R2 bucket (or devscore_cache below).
CREATE TABLE IF NOT EXISTS devscore_jobs (
  username           TEXT NOT NULL,
  collection_version TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  state              TEXT NOT NULL CHECK(state IN ('queued', 'running', 'done', 'failed')),
  phase              TEXT NOT NULL DEFAULT 'queued',
  progress           REAL NOT NULL DEFAULT 0,
  collect_state      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_run_at        INTEGER NOT NULL,
  lease_token        TEXT,
  lease_expires_at   INTEGER,
  started_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_error         TEXT,
  PRIMARY KEY (username, collection_version)
);
CREATE INDEX IF NOT EXISTS idx_devscore_jobs_ready
  ON devscore_jobs(state, next_run_at);

-- Fallback CollectStore when the DEVSCORE_CACHE R2 binding is absent (local
-- Turso/dev). Production reads/writes R2; this table stays empty there.
CREATE TABLE IF NOT EXISTS devscore_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
