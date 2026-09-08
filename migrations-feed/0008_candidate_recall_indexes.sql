-- Additive index-only migration: no facts, taxonomy, epoch, or contract changes.
-- The existing long-tail index starts with two OR predicate columns and cannot
-- also provide the required analyzed_at/repo_key ordering. Index the complete
-- discovery predicate so the ordered walk skips ordinary established projects.
CREATE INDEX IF NOT EXISTS idx_feed_projects_discovery_order
  ON feed_projects(published, analyzed_at DESC, repo_key)
  WHERE treasure_eligible=1 OR exposure_band='low';
