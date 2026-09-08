-- Additive core-source seam. Apply before enabling FEED_SOURCE_OUTBOX_ENABLED.
-- Feed databases/queues are never part of the assessment commit transaction.
CREATE TABLE IF NOT EXISTS feed_submission_receipts (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL UNIQUE REFERENCES project_analysis_runs(id),
  requested_repo_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('app_submission', 'agent_submission', 'verified_backfill')),
  submitted_at INTEGER NOT NULL,
  evidence_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_source_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assessment.completed')),
  analysis_id TEXT NOT NULL REFERENCES project_analysis_runs(id),
  receipt_id TEXT NOT NULL REFERENCES feed_submission_receipts(id),
  source_hash TEXT NOT NULL,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  occurred_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
  lease_token TEXT,
  lease_expires_at INTEGER,
  delivered_at INTEGER,
  last_error TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0,
  replay_reason TEXT,
  replayed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feed_source_outbox_delivery
  ON feed_source_outbox(status, available_at, sequence);
CREATE INDEX IF NOT EXISTS idx_feed_source_outbox_leases
  ON feed_source_outbox(status, lease_expires_at, sequence);
CREATE INDEX IF NOT EXISTS idx_feed_source_outbox_aggregate
  ON feed_source_outbox(aggregate_key, sequence);

-- A failed guard aborts the complete D1 batch, including earlier statements.
-- Successful transactions remove their guard; no process-local locking is used.
CREATE TABLE IF NOT EXISTS feed_source_assertions (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
