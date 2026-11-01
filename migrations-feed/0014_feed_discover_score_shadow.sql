-- Additive, write-only discover-score shadow columns. Safe to reapply only
-- through d1 migrations (ADD COLUMN is not idempotent by itself). No backfill:
-- existing rows keep NULL/'' until their next ordinary projection. No reader
-- (public Discover, Feed candidates, store mappers) selects these columns.
ALTER TABLE feed_projects ADD COLUMN discover_score INTEGER;
ALTER TABLE feed_projects ADD COLUMN discover_band TEXT NOT NULL DEFAULT '';
ALTER TABLE feed_projects ADD COLUMN discover_score_version TEXT NOT NULL DEFAULT '';
