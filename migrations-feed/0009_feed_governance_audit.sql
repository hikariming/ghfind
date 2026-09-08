-- Operator-only single-proposal governance. Existing proposals and taxonomy
-- facts are not rewritten or approved by this additive migration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_taxonomy_one_active
  ON feed_taxonomy_versions(status) WHERE status='active';
CREATE TABLE IF NOT EXISTS feed_governance_commands (
  command_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('create','map','reject','deprecate')),
  writer_epoch INTEGER NOT NULL,
  expected_taxonomy_version INTEGER NOT NULL,
  proposal_kind TEXT CHECK(proposal_kind IN ('assessment','user')),
  proposal_id TEXT,
  repo_key TEXT,
  analysis_id TEXT,
  evidence_hash TEXT,
  canonical_tag_id TEXT,
  assignment_weight REAL CHECK(assignment_weight>=0 AND assignment_weight<=1),
  assignment_confidence REAL CHECK(assignment_confidence>=0 AND assignment_confidence<=1),
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  taxonomy_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_governance_proposal
  ON feed_governance_commands(proposal_kind,proposal_id,created_at);
CREATE TABLE IF NOT EXISTS feed_governance_guards (
  id TEXT PRIMARY KEY,
  identity_ok INTEGER NOT NULL CONSTRAINT governance_command_conflict CHECK(identity_ok=1),
  writer_ok INTEGER NOT NULL CONSTRAINT writer_epoch_changed CHECK(writer_ok=1),
  taxonomy_ok INTEGER NOT NULL CONSTRAINT taxonomy_version_changed CHECK(taxonomy_ok=1),
  proposal_ok INTEGER NOT NULL CONSTRAINT governance_proposal_changed CHECK(proposal_ok=1),
  state_ok INTEGER NOT NULL CONSTRAINT governance_not_pending CHECK(state_ok=1),
  evidence_ok INTEGER NOT NULL CONSTRAINT governance_evidence_changed CHECK(evidence_ok=1),
  tag_ok INTEGER NOT NULL CONSTRAINT governance_tag_conflict CHECK(tag_ok=1),
  apply INTEGER NOT NULL CHECK(apply IN (0,1))
);
