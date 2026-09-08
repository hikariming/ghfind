-- No existing proposals are approved and no user/profile versions are rewritten.
-- Receipts remain independent of proposal/user deletion for exact command replay.
CREATE TABLE feed.governance_commands (
 command_id TEXT PRIMARY KEY,
 action TEXT NOT NULL CHECK(action IN ('create','map','reject','deprecate')),
 writer_epoch BIGINT NOT NULL,
 expected_taxonomy_version BIGINT NOT NULL,
 proposal_kind TEXT CHECK(proposal_kind IN ('assessment','user')),
 proposal_id TEXT,
 repo_key TEXT,
 analysis_id TEXT,
 evidence_hash TEXT,
 canonical_tag_id TEXT,
 operator TEXT NOT NULL,
 reason TEXT NOT NULL,
 assignment_weight DOUBLE PRECISION CHECK(assignment_weight BETWEEN 0 AND 1),
 assignment_confidence DOUBLE PRECISION CHECK(assignment_confidence BETWEEN 0 AND 1),
 payload_hash TEXT NOT NULL,
 result_json JSONB NOT NULL,
 taxonomy_version BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE feed.project_submission_evidence ADD COLUMN revoked_at TIMESTAMPTZ;
