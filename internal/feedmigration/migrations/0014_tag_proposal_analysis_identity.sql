-- A proposed tag is evidence from one immutable assessment, not a permanent
-- property of a repository. Bind it to that assessment and retain whether its
-- namespace was explicitly supplied by the v3 artifact contract.
ALTER TABLE feed.tag_proposals
  ADD COLUMN IF NOT EXISTS analysis_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS namespace_inferred BOOLEAN NOT NULL DEFAULT true;

UPDATE feed.tag_proposals AS proposal
SET analysis_id = project.analysis_id
FROM feed.projects AS project
WHERE proposal.analysis_id = '' AND proposal.source_ref = project.repo_key;

ALTER TABLE feed.tag_proposals
  DROP CONSTRAINT IF EXISTS tag_proposals_status_check;
ALTER TABLE feed.tag_proposals
  ADD CONSTRAINT tag_proposals_status_check
  CHECK (status IN ('proposed', 'mapped', 'rejected', 'superseded'));

ALTER TABLE feed.tag_proposals
  DROP CONSTRAINT IF EXISTS tag_proposals_namespace_slug_source_ref_key;
ALTER TABLE feed.tag_proposals
  ADD CONSTRAINT tag_proposals_analysis_identity
  UNIQUE (namespace, slug, source, source_ref, analysis_id);

CREATE INDEX IF NOT EXISTS tag_proposals_current_agent
  ON feed.tag_proposals (namespace, slug, analysis_id)
  WHERE status = 'proposed' AND source = 'agent';
