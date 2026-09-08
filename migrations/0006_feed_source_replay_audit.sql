-- Core relay recovery is independent of the Feed writer epoch/profile.
-- Only an operator command may restart a failed source delivery.
CREATE TABLE IF NOT EXISTS feed_source_operator_commands (
  command_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL REFERENCES feed_source_outbox(sequence),
  event_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  operator TEXT NOT NULL CHECK(length(operator) BETWEEN 1 AND 100),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 500),
  accepted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_source_operator_commands_sequence
  ON feed_source_operator_commands(sequence,accepted_at);
CREATE TABLE IF NOT EXISTS feed_source_operator_guards (
  id TEXT PRIMARY KEY,
  identity_ok INTEGER NOT NULL CONSTRAINT source_replay_conflict CHECK(identity_ok=1),
  eligible_ok INTEGER NOT NULL CONSTRAINT source_replay_not_allowed CHECK(eligible_ok=1)
);
