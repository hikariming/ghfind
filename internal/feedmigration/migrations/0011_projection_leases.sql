ALTER TABLE feed.projection_cursors
  ADD COLUMN locked_by TEXT,
  ADD COLUMN locked_until TIMESTAMPTZ;

CREATE INDEX projection_cursors_expired_lease
  ON feed.projection_cursors (locked_until)
  WHERE locked_until IS NOT NULL;
