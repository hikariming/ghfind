ALTER TABLE feed.projection_failures
  ADD COLUMN source_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN dead_lettered_at TIMESTAMPTZ;

CREATE INDEX projection_failures_retry_ready
  ON feed.projection_failures (projection, available_at, id)
  WHERE resolved_at IS NULL AND dead_lettered_at IS NULL;
