-- Reversible public hide list for Discover project cards (for example, when
-- the upstream GitHub repository no longer exists). Assessments and analysis
-- history are untouched. Restore a card by setting restored_at; do not delete.
CREATE TABLE IF NOT EXISTS project_delistings (
  repo_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  delisted_at INTEGER NOT NULL,
  restored_at INTEGER
);
