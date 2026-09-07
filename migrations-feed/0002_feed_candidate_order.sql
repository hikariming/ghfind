-- Match the baseline candidate query's exact published-project ordering.
-- The initial catalog index omitted confidence, which forces SQLite to build a
-- temporary sort for the remaining ORDER BY terms as the directory grows.
-- Keep the original index for compatibility; this additive composite index
-- includes both the published predicate and every ORDER BY term.
CREATE INDEX IF NOT EXISTS idx_feed_projects_candidate_order
  ON feed_projects(published, product_score DESC, confidence DESC, analyzed_at DESC, repo_key);
