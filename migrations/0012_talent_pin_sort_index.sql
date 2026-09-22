-- The directory's default ordering changed to (pinned DESC, sort_order ASC,
-- created_at DESC) in 0011, so idx_talent_profiles_status_sort no longer
-- covers it. This index lets paginated recommended-order pages iterate the
-- index and probe scores per row instead of scanning and sorting the whole
-- published set on every request.
CREATE INDEX IF NOT EXISTS idx_talent_profiles_status_pin_sort
  ON talent_profiles(status, pinned DESC, sort_order ASC, created_at DESC);
