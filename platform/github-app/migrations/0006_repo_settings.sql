-- Keyed by repository alone: GitHub repository IDs are global, so settings
-- survive uninstall/reinstall. installation is the last one that saved them.
CREATE TABLE repo_settings (
  repository INTEGER PRIMARY KEY,
  installation INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  issues_enabled INTEGER NOT NULL DEFAULT 1,
  prs_enabled INTEGER NOT NULL DEFAULT 1,
  comments_enabled INTEGER NOT NULL DEFAULT 0,
  comment_prompt TEXT NOT NULL DEFAULT '',
  triage_enabled INTEGER NOT NULL DEFAULT 0,
  allowed_labels TEXT NOT NULL DEFAULT '[]',
  backfill_limit INTEGER NOT NULL DEFAULT 25,
  updated INTEGER NOT NULL,
  updated_by TEXT
);
