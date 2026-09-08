-- A replay is accepted only together with a durable transport command.
CREATE INDEX IF NOT EXISTS idx_feed_execution_source_version ON feed_execution_jobs(source_version,event_id);
CREATE TABLE IF NOT EXISTS feed_delivery_heads (
  event_id TEXT PRIMARY KEY REFERENCES feed_execution_jobs(event_id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_replay_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES feed_execution_jobs(event_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','published','failed','superseded','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=8),
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_replay_delivery_due ON feed_replay_deliveries(status,available_at);
CREATE INDEX IF NOT EXISTS idx_feed_replay_delivery_lease ON feed_replay_deliveries(status,lease_until);
CREATE INDEX IF NOT EXISTS idx_feed_replay_delivery_event ON feed_replay_deliveries(event_id,delivery_id);
CREATE TABLE IF NOT EXISTS feed_delivery_terminals (
  queue TEXT NOT NULL,
  message_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES feed_execution_jobs(event_id) ON DELETE CASCADE,
  envelope_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(queue,message_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_delivery_terminals_current ON feed_delivery_terminals(event_id,delivery_id,received_at);
CREATE TABLE IF NOT EXISTS feed_delivery_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT delivery_identity_mismatch CHECK(valid=1)
);
UPDATE feed_runtime_control SET schema_version=6 WHERE id=1 AND schema_version=5;
