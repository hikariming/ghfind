-- Dedicated Cloudflare D1 store for the personalized project Feed.
-- Project assessment facts remain in the GHFIND_D1 core binding; this database
-- owns only rebuildable project projections and Feed-only user behavior.

CREATE TABLE feed_taxonomy_versions (
  version INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active', 'retired')),
  created_at INTEGER NOT NULL
);
CREATE TABLE feed_tag_definitions (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL CHECK(namespace IN ('domain', 'use_case', 'audience', 'artifact', 'stack', 'stage')),
  slug TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('canonical', 'alias', 'proposed', 'rejected', 'deprecated')),
  taxonomy_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(namespace, slug)
);
CREATE TABLE feed_tag_aliases (
  namespace TEXT NOT NULL CHECK(namespace IN ('domain', 'use_case', 'audience', 'artifact', 'stack', 'stage')),
  slug TEXT NOT NULL,
  canonical_tag_id TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, slug)
);
CREATE TABLE feed_projects (
  repo_key TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  language TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  project_type TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  product_score REAL NOT NULL,
  confidence REAL NOT NULL,
  verification_level TEXT NOT NULL,
  exposure_band TEXT NOT NULL,
  treasure_eligible INTEGER NOT NULL DEFAULT 0,
  classic_eligible INTEGER NOT NULL DEFAULT 0,
  analyzed_at INTEGER NOT NULL,
  risks_json TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0, 1)),
  source_hash TEXT NOT NULL,
  projected_at INTEGER NOT NULL
);
CREATE TABLE feed_project_moderation (
  repo_key TEXT PRIMARY KEY,
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0, 1)),
  allow_high_risk INTEGER NOT NULL DEFAULT 0 CHECK(allow_high_risk IN (0, 1)),
  reason TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE feed_project_tags (
  repo_key TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('assessment', 'derived', 'admin')),
  weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  analysis_id TEXT NOT NULL,
  taxonomy_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(repo_key, tag_id)
);
CREATE TABLE feed_tag_proposals (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK(namespace IN ('domain', 'use_case', 'audience', 'artifact', 'stack', 'stage')),
  slug TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('proposed', 'accepted', 'rejected')),
  reviewed_by TEXT,
  review_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repo_key, analysis_id, namespace, slug)
);
CREATE TABLE feed_users (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT,
  profile_version INTEGER NOT NULL DEFAULT 1,
  taxonomy_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE feed_user_tag_preferences (
  github_id INTEGER NOT NULL,
  tag_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (-1, 1)),
  source TEXT NOT NULL CHECK(source IN ('explicit', 'graph', 'behavior')),
  strength REAL NOT NULL CHECK(strength >= 0 AND strength <= 1),
  taxonomy_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(github_id, tag_id, source)
);
CREATE TABLE feed_user_project_states (
  github_id INTEGER NOT NULL,
  repo_key TEXT NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0 CHECK(saved IN (0, 1)),
  not_interested INTEGER NOT NULL DEFAULT 0 CHECK(not_interested IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(github_id, repo_key),
  CHECK(NOT (saved = 1 AND not_interested = 1))
);
CREATE TABLE feed_events (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL,
  repo_key TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('impression', 'detail_open', 'dwell', 'github_outbound', 'share', 'save', 'not_interested')),
  occurred_at INTEGER NOT NULL,
  duration_ms INTEGER,
  request_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE feed_served_items (
  request_id TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  repo_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  source TEXT NOT NULL,
  propensity REAL NOT NULL,
  exploration INTEGER NOT NULL DEFAULT 0 CHECK(exploration IN (0, 1)),
  served_at INTEGER NOT NULL,
  PRIMARY KEY(request_id, repo_key)
);
CREATE TABLE feed_rate_windows (
  github_id INTEGER NOT NULL,
  bucket TEXT NOT NULL,
  window_started INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(github_id, bucket, window_started)
);

CREATE INDEX idx_feed_projects_catalog ON feed_projects(published, product_score DESC, analyzed_at DESC, repo_key);
CREATE INDEX idx_feed_project_tags_tag ON feed_project_tags(tag_id, repo_key);
CREATE INDEX idx_feed_project_tags_repo ON feed_project_tags(repo_key, tag_id);
CREATE INDEX idx_feed_proposals_review ON feed_tag_proposals(status, namespace, slug, updated_at);
CREATE INDEX idx_feed_states_user_interest ON feed_user_project_states(github_id, not_interested, updated_at);
CREATE INDEX idx_feed_events_user_repo_type_time ON feed_events(github_id, repo_key, type, occurred_at DESC);
CREATE INDEX idx_feed_served_user_time ON feed_served_items(github_id, served_at DESC);

INSERT INTO feed_taxonomy_versions(version, status, created_at)
VALUES (1, 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- Closed enums are safe canonical tags: their values are validated by the
-- project-analysis artifact contract. Open-ended assessment tags are never
-- seeded here and remain proposals until a reviewer accepts or maps them.
INSERT INTO feed_tag_definitions
  (id, namespace, slug, label_zh, label_en, description, status, taxonomy_version, created_at, updated_at)
VALUES
  ('artifact:micro-tool', 'artifact', 'micro-tool', '微型工具', 'Micro tool', 'A focused utility for one task.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:sdk-library', 'artifact', 'sdk-library', 'SDK / 库', 'SDK / library', 'A reusable developer library or SDK.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:web-app', 'artifact', 'web-app', 'Web 应用', 'Web app', 'A browser-delivered application.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:desktop-app', 'artifact', 'desktop-app', '桌面应用', 'Desktop app', 'A native desktop application.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:framework-platform', 'artifact', 'framework-platform', '框架 / 平台', 'Framework / platform', 'A framework, runtime or platform.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:database-infra', 'artifact', 'database-infra', '数据 / 基础设施', 'Data / infrastructure', 'A database or infrastructure component.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:template-scaffold', 'artifact', 'template-scaffold', '模板 / 脚手架', 'Template / scaffold', 'A starter, template or scaffolding tool.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:enterprise-system', 'artifact', 'enterprise-system', '企业系统', 'Enterprise system', 'A system intended for organizational workflows.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('stage:active-evolution', 'stage', 'active-evolution', '活跃演进', 'Active evolution', 'Actively evolving project.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('stage:stable-maintenance', 'stage', 'stable-maintenance', '稳定维护', 'Stable maintenance', 'Stable project in maintenance.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('stage:feature-complete', 'stage', 'feature-complete', '功能完成', 'Feature complete', 'Project primarily receiving fixes.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('stage:experimental', 'stage', 'experimental', '实验阶段', 'Experimental', 'Early experimental project.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('stage:abandoned', 'stage', 'abandoned', '已停更', 'Abandoned', 'No longer actively maintained.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
