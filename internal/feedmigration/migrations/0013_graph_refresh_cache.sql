-- Feed cold-start reads Turso developer facets. Cache the materialized graph
-- profile in Postgres so a scrolling user never turns into a Turso read per
-- request, while retaining a short, crash-safe single-owner refresh lease.
ALTER TABLE feed.users
  ADD COLUMN IF NOT EXISTS graph_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graph_refresh_locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graph_taxonomy_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS graph_profile_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS users_graph_refresh_due
  ON feed.users (graph_checked_at)
  WHERE deleted_at IS NULL;
