-- A prior cleanup may have erased the body and author but left the shared slug
-- and command -> proposal link. The old natural key proves that every such
-- referring command submitted this same slug. This repair never attributes an
-- intact, unknown body from a remaining deduplicated receipt alone.
WITH linked AS (
 SELECT c.proposal_id,c.github_id,c.profile_version,
 ROW_NUMBER() OVER(PARTITION BY c.proposal_id ORDER BY c.created_at,c.github_id,c.command_id) AS position
 FROM feed_tag_proposal_commands c JOIN feed_user_tag_proposals q ON q.id=c.proposal_id
 WHERE c.profile_version>0 AND c.profile_version<=COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=c.github_id),0)
 AND q.label_zh='' AND q.label_en='Deleted proposal' AND q.evidence_json='[]'
 AND NOT EXISTS(SELECT 1 FROM feed_user_proposal_authors a WHERE a.proposal_id=q.id)
)
INSERT INTO feed_user_proposal_authors(proposal_id,github_id,profile_version)
 SELECT proposal_id,github_id,profile_version FROM linked WHERE position=1;
UPDATE feed_user_proposal_authors SET redacted_at=NULL
 WHERE profile_version<=COALESCE((SELECT profile_floor FROM feed_profile_floors f WHERE f.github_id=feed_user_proposal_authors.github_id),0);
UPDATE feed_cleanup_jobs SET primary_table=0,phase='primary' WHERE status<>'completed';
UPDATE feed_cleanup_jobs SET status='pending',phase='primary',primary_table=0,available_at=0,lease_owner=NULL,lease_until=NULL
 WHERE status='completed' AND (
 EXISTS(SELECT 1 FROM feed_user_proposal_authors a WHERE a.github_id=feed_cleanup_jobs.github_id AND a.profile_version<=feed_cleanup_jobs.profile_floor)
 OR EXISTS(SELECT 1 FROM feed_tag_proposal_commands c WHERE c.github_id=feed_cleanup_jobs.github_id AND c.profile_version<=feed_cleanup_jobs.profile_floor
 AND (c.proposal_id<>'' OR c.payload_hash<>'deleted' OR c.created_at<>0)));
UPDATE feed_profile_deletions SET status='pending',primary_complete=0
 WHERE id IN(SELECT deletion_id FROM feed_cleanup_jobs WHERE phase='primary');
DROP VIEW feed_user_proposal_quarantine_summary;
CREATE VIEW feed_user_proposal_quarantine_summary AS
 SELECT COUNT(*) AS quarantined_proposals,
 COALESCE(SUM(CASE WHEN q.label_zh<>'' OR q.label_en NOT IN ('','Deleted proposal') OR q.evidence_json<>'[]' OR q.slug NOT IN ('','deleted-proposal') THEN 1 ELSE 0 END),0) AS retained_body_proposals
 FROM feed_user_tag_proposals q WHERE NOT EXISTS(SELECT 1 FROM feed_user_proposal_authors a WHERE a.proposal_id=q.id);

-- Removing user proposal natural-key sharing changes write semantics. The HTTP
-- read/transport contract stays v1; only implementations using writer contract
-- v2 may write after this migration. Release promotion must fence old writers.
UPDATE feed_schema_compatibility SET min_writer_contract=2,max_writer_contract=2;
