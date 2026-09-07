-- The Cloudflare-native Feed has its own D1 database and migrations directory.
-- Keep this core-store migration deliberately small: it supports bounded,
-- operator-triggered reads of assessment changes without adding Feed state to
-- the high-volume scoring database.
CREATE INDEX IF NOT EXISTS idx_project_assessments_feed_updates
  ON project_assessments(updated_at, repo_key);
