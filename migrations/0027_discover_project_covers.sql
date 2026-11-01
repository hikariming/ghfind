CREATE TABLE IF NOT EXISTS discover_project_covers (
  repo_key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  image_base64 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
