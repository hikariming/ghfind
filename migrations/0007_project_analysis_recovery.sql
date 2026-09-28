-- Explicit operator recovery: preserve old execution identity and permit only one recovery per analysis.
CREATE TABLE IF NOT EXISTS project_analysis_recoveries (
  analysis_id TEXT PRIMARY KEY REFERENCES project_analysis_runs(id),
  request_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('retry_interrupted', 'finalize_completed')),
  requested_ref TEXT NOT NULL,
  original_thread_id TEXT NOT NULL,
  original_run_id TEXT NOT NULL,
  original_idempotency_key TEXT NOT NULL,
  original_started_at INTEGER,
  original_create_attempts INTEGER NOT NULL,
  original_error_code TEXT NOT NULL,
  original_error_message TEXT,
  original_completed_at INTEGER,
  original_updated_at INTEGER NOT NULL,
  operator_ref TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  execution_deadline_at INTEGER,
  next_idempotency_key TEXT NOT NULL,
  CHECK ((action = 'retry_interrupted' AND execution_deadline_at > requested_at)
    OR (action = 'finalize_completed' AND execution_deadline_at IS NULL))
);

-- A transaction-local assertion makes supersession checks atomic with publication.
CREATE TABLE IF NOT EXISTS project_analysis_recovery_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
