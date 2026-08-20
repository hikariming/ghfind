CREATE TABLE feed.user_deletion_tombstones (
  deletion_id TEXT PRIMARY KEY,
  github_id BIGINT NOT NULL CHECK (github_id > 0),
  gorse_user_id TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_deletion_tombstones_requested
  ON feed.user_deletion_tombstones (requested_at, deletion_id);
