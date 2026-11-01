-- Score-board ordering and bounded per-user visit enrichment.
CREATE INDEX IF NOT EXISTS idx_scores_public_order
  ON scores(hidden, score_version, final_score DESC, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_lookup_limits_user_counted
  ON account_lookup_limits(username, last_counted_at);
