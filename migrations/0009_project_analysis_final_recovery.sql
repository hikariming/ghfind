-- Preserve migration 0007 and its first recovery audit. Only one final retry is allowed.
CREATE TABLE IF NOT EXISTS project_analysis_final_recoveries (
  analysis_id TEXT PRIMARY KEY REFERENCES project_analysis_runs(id),
  request_id TEXT NOT NULL UNIQUE,
  predecessor_request_id TEXT NOT NULL REFERENCES project_analysis_recoveries(request_id),
  retry_number INTEGER NOT NULL DEFAULT 2 CHECK (retry_number = 2),
  action TEXT NOT NULL CHECK (action = 'retry_interrupted_final'),
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
  CHECK (execution_deadline_at IS NOT NULL AND execution_deadline_at > requested_at)
);
