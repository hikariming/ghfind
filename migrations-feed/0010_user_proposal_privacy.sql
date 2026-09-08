-- No natural-key sharing of user-authored bodies. Each new actor command owns
-- one proposal; existing rows/identifiers/statuses remain unchanged.
CREATE TABLE feed_user_tag_proposals_v10 (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK(source='user'),
  namespace TEXT NOT NULL CHECK(namespace IN ('domain','use_case','audience','artifact','stack','stage')),
  slug TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL CHECK(status IN ('proposed','mapped','rejected')),
  reviewed_by TEXT,
  review_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO feed_user_tag_proposals_v10 SELECT * FROM feed_user_tag_proposals;
DROP TABLE feed_user_tag_proposals;
ALTER TABLE feed_user_tag_proposals_v10 RENAME TO feed_user_tag_proposals;
CREATE INDEX idx_feed_user_proposals_project ON feed_user_tag_proposals(repo_key,analysis_id);
CREATE INDEX idx_feed_user_proposal_authors_generation ON feed_user_proposal_authors(github_id,profile_version,proposal_id);
ALTER TABLE feed_project_tags ADD COLUMN origin_proposal_id TEXT;
CREATE INDEX idx_feed_project_tags_proposal_origin ON feed_project_tags(origin_proposal_id) WHERE origin_proposal_id IS NOT NULL;
ALTER TABLE feed_governance_guards ADD COLUMN author_ok INTEGER NOT NULL DEFAULT 1 CONSTRAINT governance_proposal_deleted CHECK(author_ok=1);
UPDATE feed_user_proposal_authors SET redacted_at=NULL
 WHERE profile_version<=COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=feed_user_proposal_authors.github_id),0);
-- Restart idempotent primary work under the stronger erasure protocol. Preserve
-- failed/manual-replay state and active leases; no completed record is reopened
-- without a remaining, attributable source body.
UPDATE feed_cleanup_jobs SET primary_table=0,phase='primary'
 WHERE status<>'completed';
UPDATE feed_cleanup_jobs SET status='pending',phase='primary',primary_table=0,available_at=0,lease_owner=NULL,lease_until=NULL
 WHERE status='completed' AND EXISTS(SELECT 1 FROM feed_user_proposal_authors a
 WHERE a.github_id=feed_cleanup_jobs.github_id AND a.profile_version<=feed_cleanup_jobs.profile_floor);
UPDATE feed_profile_deletions SET status='pending',primary_complete=0
 WHERE id IN(SELECT deletion_id FROM feed_cleanup_jobs WHERE phase='primary');
-- Aggregate-only inventory. An unowned historical body is not evidence that a
-- particular actor's cleanup succeeded, and it must block production promotion
-- until an operator records a defensible disposition.
CREATE VIEW feed_user_proposal_quarantine_summary AS
 SELECT COUNT(*) AS quarantined_proposals,
 COALESCE(SUM(CASE WHEN q.label_zh<>'' OR q.label_en NOT IN ('','Deleted proposal') OR q.evidence_json<>'[]' THEN 1 ELSE 0 END),0) AS retained_body_proposals
 FROM feed_user_tag_proposals q WHERE NOT EXISTS(SELECT 1 FROM feed_user_proposal_authors a WHERE a.proposal_id=q.id);
