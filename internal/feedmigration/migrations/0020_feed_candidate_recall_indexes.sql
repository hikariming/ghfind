-- Match quality recall's full deterministic order. The existing quality
-- index orders analyzed_at before repo_key, which cannot satisfy this path.
-- Keep the older index for compatibility; this addition does not rewrite data.
CREATE INDEX projects_publishable_quality_recall
  ON feed.projects (product_score DESC, confidence DESC, repo_key)
  WHERE publishable = true;
