DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector extension is required; install/enable vector before running Feed migrations';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS feed;

CREATE TABLE feed.taxonomy_versions (
  version BIGINT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX taxonomy_one_active_version
  ON feed.taxonomy_versions (state) WHERE state = 'active';

CREATE TABLE feed.tag_definitions (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL CHECK (namespace IN ('domain', 'use_case', 'audience', 'artifact', 'stack', 'stage')),
  slug TEXT NOT NULL,
  label_zh TEXT NOT NULL,
  label_en TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('canonical', 'deprecated')),
  replacement_id TEXT REFERENCES feed.tag_definitions(id),
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace, slug),
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CHECK ((status = 'deprecated') OR replacement_id IS NULL)
);

CREATE TABLE feed.tag_aliases (
  namespace TEXT NOT NULL CHECK (namespace IN ('domain', 'use_case', 'audience', 'artifact', 'stack', 'stage')),
  alias_slug TEXT NOT NULL,
  canonical_tag_id TEXT NOT NULL REFERENCES feed.tag_definitions(id) ON DELETE CASCADE,
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, alias_slug),
  CHECK (alias_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE feed.tag_proposals (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL CHECK (namespace IN ('domain', 'use_case', 'audience', 'artifact', 'stack', 'stage')),
  slug TEXT NOT NULL,
  label_zh TEXT NOT NULL DEFAULT '',
  label_en TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('agent', 'owner', 'user', 'github_topic', 'system')),
  source_ref TEXT NOT NULL DEFAULT '',
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'mapped', 'rejected')) DEFAULT 'proposed',
  canonical_tag_id TEXT REFERENCES feed.tag_definitions(id),
  resolved_by TEXT,
  resolution_reason TEXT,
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (namespace, slug, source_ref),
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE INDEX tag_proposals_pending ON feed.tag_proposals (created_at) WHERE status = 'proposed';

CREATE TABLE feed.projects (
  repo_key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE,
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  summary TEXT NOT NULL,
  pain_statement TEXT NOT NULL DEFAULT '',
  target_users JSONB NOT NULL DEFAULT '[]'::jsonb,
  language TEXT,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_type TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  product_score DOUBLE PRECISION NOT NULL CHECK (product_score BETWEEN 0 AND 100),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  verification_level TEXT NOT NULL,
  exposure_band TEXT NOT NULL,
  treasure_eligible BOOLEAN NOT NULL DEFAULT false,
  classic_eligible BOOLEAN NOT NULL DEFAULT false,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis_id TEXT NOT NULL,
  resolved_commit_sha TEXT NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL,
  descriptor TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  publishable BOOLEAN NOT NULL DEFAULT false,
  blocked_reason TEXT,
  admin_override BOOLEAN NOT NULL DEFAULT false,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (repo_key = lower(repo_key)),
  CHECK (repo_key ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  CHECK (item_id !~ '/'),
  CHECK (resolved_commit_sha ~ '^[0-9a-f]{40}$')
);

CREATE INDEX projects_publishable_quality
  ON feed.projects (product_score DESC, confidence DESC, analyzed_at DESC)
  WHERE publishable = true;
CREATE INDEX projects_publishable_latest
  ON feed.projects (analyzed_at DESC, repo_key) WHERE publishable = true;

CREATE TABLE feed.project_tags (
  repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES feed.tag_definitions(id),
  source TEXT NOT NULL CHECK (source IN ('agent', 'editor', 'owner', 'github_topic', 'system')),
  weight DOUBLE PRECISION NOT NULL CHECK (weight BETWEEN 0 AND 1),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis_id TEXT NOT NULL,
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, tag_id, source)
);

CREATE INDEX project_tags_recall ON feed.project_tags (tag_id, weight DESC, repo_key);

CREATE TABLE feed.users (
  github_id BIGINT PRIMARY KEY CHECK (github_id > 0),
  login TEXT NOT NULL,
  avatar_url TEXT,
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  profile_version BIGINT NOT NULL DEFAULT 1,
  embedding_profile_version BIGINT NOT NULL DEFAULT 0,
  embedding_model TEXT NOT NULL DEFAULT '',
  graph_source_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE feed.user_tag_preferences (
  github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES feed.tag_definitions(id),
  value SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  source TEXT NOT NULL CHECK (source IN ('explicit', 'graph', 'behavior')),
  strength DOUBLE PRECISION NOT NULL CHECK (strength BETWEEN 0 AND 1),
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (github_id, tag_id, source)
);

CREATE TABLE feed.user_project_state (
  github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
  repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key) ON DELETE CASCADE,
  saved BOOLEAN NOT NULL DEFAULT false,
  not_interested BOOLEAN NOT NULL DEFAULT false,
  saved_at TIMESTAMPTZ,
  not_interested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (github_id, repo_key)
);

CREATE INDEX user_project_state_blocked ON feed.user_project_state (github_id, repo_key)
  WHERE not_interested = true;

CREATE TABLE feed.project_embeddings (
  repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  descriptor_hash TEXT NOT NULL,
  embedding vector NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, model, descriptor_hash)
);

CREATE UNIQUE INDEX project_embeddings_one_active
  ON feed.project_embeddings (repo_key) WHERE active = true;

CREATE TABLE feed.tag_embeddings (
  tag_id TEXT NOT NULL REFERENCES feed.tag_definitions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  descriptor_hash TEXT NOT NULL,
  embedding vector NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tag_id, model, descriptor_hash)
);

CREATE TABLE feed.user_profile_embeddings (
  github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  profile_version BIGINT NOT NULL,
  embedding vector NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (github_id, model, profile_version)
);

CREATE UNIQUE INDEX user_profile_embeddings_one_active
  ON feed.user_profile_embeddings (github_id) WHERE active = true;

CREATE TABLE feed.requests (
  id TEXT PRIMARY KEY,
  github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  taxonomy_version BIGINT NOT NULL REFERENCES feed.taxonomy_versions(version),
  profile_version BIGINT NOT NULL,
  seed TEXT NOT NULL,
  candidate_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  degraded JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX requests_user_created ON feed.requests (github_id, created_at DESC);

CREATE TABLE feed.served_items (
  request_id TEXT NOT NULL REFERENCES feed.requests(id) ON DELETE CASCADE,
  repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key),
  rank INTEGER NOT NULL CHECK (rank >= 0),
  candidate_sources JSONB NOT NULL,
  reason_codes JSONB NOT NULL,
  feature_snapshot JSONB NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  exploration BOOLEAN NOT NULL,
  propensity DOUBLE PRECISION NOT NULL CHECK (propensity > 0 AND propensity <= 1),
  served_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, rank),
  UNIQUE (request_id, repo_key)
);

CREATE TABLE feed.events (
  id TEXT PRIMARY KEY,
  github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
  repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key),
  request_id TEXT REFERENCES feed.requests(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'detail_open', 'dwell', 'github_outbound', 'share', 'save', 'unsave', 'not_interested', 'undo_not_interested')),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX events_user_recent ON feed.events (github_id, occurred_at DESC);
CREATE INDEX events_project_type_time ON feed.events (repo_key, event_type, occurred_at DESC);
CREATE INDEX events_retention ON feed.events (received_at);

CREATE TABLE feed.event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT UNIQUE REFERENCES feed.events(id) ON DELETE CASCADE,
  aggregate_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX event_outbox_ready ON feed.event_outbox (available_at, id)
  WHERE delivered_at IS NULL;

CREATE TABLE feed.projection_cursors (
  projection TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,
  source_timestamp TIMESTAMPTZ,
  consecutive_clean_runs INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feed.projection_failures (
  id BIGSERIAL PRIMARY KEY,
  projection TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (projection, source_ref)
);

CREATE TABLE feed.algorithm_configs (
  version TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

CREATE TABLE feed.gorse_shadow_results (
  request_id TEXT PRIMARY KEY REFERENCES feed.requests(id) ON DELETE CASCADE,
  item_ids JSONB NOT NULL,
  duration_ms INTEGER NOT NULL,
  invalid_items INTEGER NOT NULL DEFAULT 0,
  overlap_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO feed.algorithm_configs (version, config, state, activated_at)
VALUES (
  'baseline-v1',
  '{"weights":{"tag":0.38,"semantic":0.30,"product":0.14,"confidence":0.06,"freshness":0.06,"discovery":0.06},"mmr_lambda":0.78,"exploration_rate":0.10,"max_exploration_per_page":2}'::jsonb,
  'active',
  now()
) ON CONFLICT (version) DO NOTHING;
