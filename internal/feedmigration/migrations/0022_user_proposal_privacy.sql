-- User proposal ownership survives deleting feed.users until bounded cleanup
-- has erased the proposal body and any assignment that copied that body.
CREATE TABLE feed.user_proposal_authors (
 proposal_id TEXT PRIMARY KEY REFERENCES feed.tag_proposals(id) ON DELETE CASCADE,
 github_id BIGINT NOT NULL CHECK (github_id > 0),
 profile_version BIGINT NOT NULL CHECK (profile_version > 0),
 redacted_at TIMESTAMPTZ
);
CREATE INDEX user_proposal_authors_cleanup ON feed.user_proposal_authors(github_id,profile_version,proposal_id);

-- A surviving command alone does not prove creation: previous code merged
-- unrelated actors' proposals. Require one actor and the original transaction
-- timestamp, a live user and no deletion history; all other user rows remain
-- quarantined (operator access requires this ownership record).
WITH proven AS (
 SELECT q.id,MIN(c.github_id) AS github_id
 FROM feed.tag_proposals q JOIN feed.tag_proposal_commands c ON c.proposal_id=q.id
 JOIN feed.users u ON u.github_id=c.github_id AND u.deleted_at IS NULL
 WHERE q.source='user'
 GROUP BY q.id,q.created_at
 HAVING COUNT(DISTINCT c.github_id)=1 AND MIN(c.created_at)=q.created_at
)
INSERT INTO feed.user_proposal_authors(proposal_id,github_id,profile_version)
SELECT id,github_id,1 FROM proven
WHERE NOT EXISTS(SELECT 1 FROM feed.user_deletion_tombstones d WHERE d.github_id=proven.github_id);

-- Keep a minimal actor/command deletion receipt instead of losing replay
-- protection through the users cascade. Unknown historical generations are 0
-- and permanently fail closed; they must not expose a proposal association.
ALTER TABLE feed.tag_proposal_commands DROP CONSTRAINT tag_proposal_commands_github_id_fkey;
ALTER TABLE feed.tag_proposal_commands ALTER COLUMN proposal_id DROP NOT NULL;
ALTER TABLE feed.tag_proposal_commands ADD COLUMN profile_version BIGINT NOT NULL DEFAULT 0 CHECK(profile_version>=0);
UPDATE feed.tag_proposal_commands c SET profile_version=a.profile_version
 FROM feed.user_proposal_authors a WHERE a.proposal_id=c.proposal_id AND a.github_id=c.github_id;
UPDATE feed.tag_proposal_commands SET proposal_id=NULL,payload_hash='deleted',created_at='epoch' WHERE profile_version=0;
CREATE INDEX tag_proposal_commands_cleanup ON feed.tag_proposal_commands(github_id,profile_version,command_id) WHERE proposal_id IS NOT NULL;

ALTER TABLE feed.tag_proposals DROP CONSTRAINT tag_proposals_analysis_identity;
CREATE UNIQUE INDEX tag_proposals_assessment_identity
 ON feed.tag_proposals(namespace,slug,source,source_ref,analysis_id) WHERE source<>'user';

ALTER TABLE feed.project_tags ADD COLUMN origin_proposal_id TEXT;
CREATE INDEX project_tags_proposal_origin ON feed.project_tags(origin_proposal_id) WHERE origin_proposal_id IS NOT NULL;
-- Pin only the exact latest assignment. Never mark a subsequent assessment or
-- another proposal's overwrite as belonging to the earlier user proposal.
UPDATE feed.project_tags p SET origin_proposal_id=c.proposal_id,
 evidence_ids=jsonb_build_array('governance:' || c.command_id)
FROM feed.governance_commands c
WHERE c.proposal_kind='user' AND c.action IN ('create','map') AND p.source='editor'
 AND c.repo_key=p.repo_key AND c.analysis_id=p.analysis_id AND c.canonical_tag_id=p.tag_id
 AND c.taxonomy_version=p.taxonomy_version AND c.assignment_weight=p.weight AND c.assignment_confidence=p.confidence
 AND c.evidence_hash=encode(sha256(convert_to(p.evidence_ids::text,'UTF8')),'hex');

ALTER TABLE feed.user_deletion_tombstones ADD COLUMN proposal_cleanup_phase TEXT NOT NULL DEFAULT 'assignments'
 CHECK(proposal_cleanup_phase IN ('assignments','proposals','commands','authors','complete'));

-- Read-only reconciliation metric. Unattributed historical bodies stay hidden
-- until evidence-backed operator disposition; an empty author table is not
-- proof that erasure or a migration promotion is complete.
CREATE VIEW feed.user_proposal_quarantine_summary AS
SELECT COUNT(*) AS quarantined_proposals,
 COUNT(*) FILTER(WHERE q.slug<>'deleted-proposal' OR q.label_zh<>'' OR q.label_en NOT IN ('','Deleted proposal') OR q.evidence_ids<>'[]'::jsonb) AS retained_body_proposals
FROM feed.tag_proposals q WHERE q.source='user'
 AND NOT EXISTS(SELECT 1 FROM feed.user_proposal_authors a WHERE a.proposal_id=q.id);

-- Reader/HTTP contract 1 remains stable; old writers lack privacy fencing and
-- use an incompatible proposal conflict target. They must fail readiness.
UPDATE feed.schema_compatibility SET min_writer_contract=2,max_writer_contract=2 WHERE singleton;
