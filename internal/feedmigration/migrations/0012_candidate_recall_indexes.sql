-- Candidate hydration repeatedly asks for the latest impression by one user
-- and project. The original pair of single-prefix indexes forced PostgreSQL to
-- choose between filtering by user or by project as event volume grew.
CREATE INDEX events_user_project_impression
  ON feed.events (github_id, repo_key, occurred_at DESC)
  WHERE event_type = 'impression';

-- Discovery recall intentionally orders low-exposure projects ahead of
-- mainstream ones. Match that exact expression so the Top 20 route remains an
-- index scan at 50k+ publishable projects instead of a whole-catalog sort.
CREATE INDEX projects_publishable_discovery
  ON feed.projects (
    (CASE exposure_band
      WHEN 'low' THEN 0
      WHEN 'emerging' THEN 1
      WHEN 'unknown' THEN 2
      ELSE 3
    END),
    product_score DESC,
    repo_key
  )
  WHERE publishable = true;
