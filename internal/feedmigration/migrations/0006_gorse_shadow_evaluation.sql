ALTER TABLE feed.gorse_shadow_results
  ADD COLUMN held_out_positives INTEGER,
  ADD COLUMN recall_at_50 DOUBLE PRECISION CHECK (recall_at_50 BETWEEN 0 AND 1),
  ADD COLUMN evaluated_at TIMESTAMPTZ;

CREATE INDEX gorse_shadow_pending_evaluation
  ON feed.gorse_shadow_results (created_at, request_id)
  WHERE evaluated_at IS NULL;
