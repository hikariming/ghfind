-- Staging-only mock schema for the Go backend. Mirrors the production Turso
-- schema created by src/lib/db.ts ensureSchema (same columns, constraints and
-- indexes the Go code relies on) so staging cannot silently accept writes the
-- production schema would reject. All statements are idempotent.

CREATE TABLE IF NOT EXISTS scores (
  username TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  final_score REAL NOT NULL,
  tier TEXT NOT NULL,
  tags TEXT,
  roast_line TEXT,
  score_version TEXT,
  score_write_token TEXT,
  score_source_collection_version TEXT,
  score_source_snapshot_hash TEXT,
  bot_score REAL,
  sub_scores TEXT,
  scanned_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  roast TEXT,
  roast_en TEXT,
  roast_version TEXT,
  roast_en_version TEXT,
  prev_score REAL,
  prev_scanned_at INTEGER,
  followers INTEGER,
  total_stars INTEGER
);

CREATE TABLE IF NOT EXISTS score_snapshots (
  id TEXT PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  final_score REAL,
  tier TEXT,
  tags TEXT,
  roast_line TEXT,
  score_version TEXT,
  roast_version TEXT,
  roast_lang TEXT,
  bot_score REAL,
  sub_scores TEXT,
  generated_at INTEGER
);

CREATE TABLE IF NOT EXISTS public_scan_runs (
  id TEXT PRIMARY KEY,
  username TEXT,
  score_version TEXT,
  collection_version TEXT,
  state TEXT,
  coverage TEXT,
  source_status TEXT,
  quick_scan TEXT,
  snapshot TEXT,
  snapshot_hash TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  id TEXT PRIMARY KEY,
  username TEXT,
  scanned_at INTEGER,
  top_repos TEXT,
  impact_repos TEXT,
  verified_prs TEXT,
  metrics TEXT,
  pinned_repos TEXT,
  organizations TEXT,
  signature_work TEXT,
  scan_version TEXT
);

CREATE TABLE IF NOT EXISTS account_stats (
  username TEXT PRIMARY KEY,
  lookup_count INTEGER NOT NULL DEFAULT 0,
  first_lookup_at INTEGER,
  last_lookup_at INTEGER
);

CREATE TABLE IF NOT EXISTS account_lookup_limits (
  username TEXT,
  ip_hash TEXT,
  last_counted_at INTEGER,
  PRIMARY KEY (username, ip_hash)
);

CREATE TABLE IF NOT EXISTS users (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_login INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS follows (
  follower_github_id INTEGER NOT NULL,
  target_username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_github_id, target_username)
);

CREATE TABLE IF NOT EXISTS profile_comments (
  id TEXT PRIMARY KEY,
  target_username TEXT NOT NULL,
  body TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_github_id INTEGER,
  author_login TEXT,
  author_avatar_url TEXT,
  created_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS blog_comments (
  id TEXT PRIMARY KEY,
  post_slug TEXT NOT NULL,
  body TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_github_id INTEGER,
  author_login TEXT,
  author_avatar_url TEXT,
  created_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_reactions (
  target_username TEXT NOT NULL,
  voter_github_id INTEGER NOT NULL,
  voter_login TEXT NOT NULL,
  reaction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_username, voter_github_id)
);

CREATE TABLE IF NOT EXISTS repos (
  repo_key TEXT PRIMARY KEY,
  name_with_owner TEXT,
  owner_login TEXT,
  name TEXT,
  description TEXT,
  stars INTEGER,
  forks INTEGER,
  language TEXT,
  topics TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS vs_matchups (
  handle_a TEXT,
  handle_b TEXT,
  winner TEXT,
  bucket TEXT,
  gap REAL,
  score_a REAL,
  score_b REAL,
  verdict TEXT,
  advice TEXT,
  verdict_source TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (handle_a, handle_b)
);

CREATE TABLE IF NOT EXISTS campaign_participants (
  campaign TEXT,
  username TEXT,
  joined_at INTEGER,
  PRIMARY KEY (campaign, username)
);

CREATE TABLE IF NOT EXISTS developer_facets (
  username TEXT NOT NULL,
  facet_type TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (username, facet_type, facet_value)
);

CREATE INDEX IF NOT EXISTS idx_developer_facets_lookup
  ON developer_facets(facet_type, facet_value, username);

CREATE TABLE IF NOT EXISTS repo_developers (
  repo_key TEXT NOT NULL,
  username TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('owner','contributor')),
  commits INTEGER,
  prs INTEGER,
  weight REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_key, username, relation)
);

CREATE INDEX IF NOT EXISTS idx_repo_developers_user ON repo_developers(username);

-- Project analysis tables mirror the final schema owned by
-- src/lib/project-analysis-db.ts (base CREATE TABLE plus the follow-up
-- ALTER TABLE columns merged in). The Go backend never creates them; this
-- mock schema only keeps staging honest.
CREATE TABLE IF NOT EXISTS project_analysis_runs (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  requested_ref TEXT,
  resolved_commit_sha TEXT,
  active_key TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  activities_json TEXT NOT NULL DEFAULT '[]',
  mosoo_agent_id TEXT,
  mosoo_thread_id TEXT UNIQUE,
  mosoo_run_id TEXT,
  schema_version TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  verification_level TEXT,
  analysis_json TEXT,
  report_markdown TEXT,
  evidence_json TEXT,
  analysis_sha256 TEXT,
  report_sha256 TEXT,
  evidence_sha256 TEXT,
  error_code TEXT,
  error_message TEXT,
  create_attempts INTEGER NOT NULL DEFAULT 0,
  create_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_analysis_runs_repo_created
  ON project_analysis_runs(repo_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_analysis_runs_status_updated
  ON project_analysis_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS project_assessments (
  repo_key TEXT PRIMARY KEY,
  latest_analysis_id TEXT NOT NULL,
  project_type TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  product_score REAL NOT NULL,
  pain_score REAL NOT NULL,
  effectiveness_score REAL NOT NULL,
  experience_score REAL NOT NULL,
  value_density_score REAL NOT NULL,
  community_strength REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL,
  verification_level TEXT NOT NULL,
  unknowns_json TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  exposure_band TEXT NOT NULL,
  stars INTEGER,
  treasure_eligible INTEGER NOT NULL DEFAULT 0,
  classic_eligible INTEGER NOT NULL DEFAULT 0,
  resolved_commit_sha TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  analyzed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_assessments_treasure
  ON project_assessments(treasure_eligible, product_score DESC, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_project_assessments_classic
  ON project_assessments(classic_eligible, product_score DESC, confidence DESC);

CREATE TABLE IF NOT EXISTS treasure_entries (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  status TEXT NOT NULL,
  selected_at INTEGER NOT NULL,
  product_score_snapshot REAL NOT NULL,
  confidence_snapshot REAL NOT NULL,
  verification_level_snapshot TEXT NOT NULL,
  stars_snapshot INTEGER,
  exposure_snapshot TEXT NOT NULL,
  reason TEXT NOT NULL,
  resolved_commit_sha TEXT NOT NULL,
  graduated_at INTEGER,
  removed_at INTEGER,
  removed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_treasure_entries_repo_selected
  ON treasure_entries(repo_key, selected_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_treasure_entries_one_active
  ON treasure_entries(repo_key) WHERE status = 'active';
