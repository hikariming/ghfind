ALTER TABLE feed.gorse_shadow_results
  ADD COLUMN evaluation_window_seconds INTEGER
  CHECK (evaluation_window_seconds BETWEEN 3600 AND 604800);
