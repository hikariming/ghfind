-- Additive Discover card copy fields. Safe to reapply. Does not rescore or republish.
-- Empty strings mean "legacy projection"; readers fall back to summary / client hook strip.
ALTER TABLE feed_projects ADD COLUMN discover_hook TEXT NOT NULL DEFAULT '';
ALTER TABLE feed_projects ADD COLUMN pain_statement TEXT NOT NULL DEFAULT '';
ALTER TABLE feed_projects ADD COLUMN audience_primary TEXT NOT NULL DEFAULT '';

-- Discover partition canonical tags (keep taxonomy version=1 until gated v2 rollout).
INSERT OR IGNORE INTO feed_tag_definitions
  (id, namespace, slug, label_zh, label_en, description, status, taxonomy_version, created_at, updated_at)
VALUES
  ('use_case:ai-agent', 'use_case', 'ai-agent', '智能体', 'AI agent', 'Autonomous or tool-using AI agent workflows.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('use_case:agent-skill', 'use_case', 'agent-skill', 'Agent 技能', 'Agent skill', 'Reusable skill/plugin packs for coding agents.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:microservice', 'artifact', 'microservice', '微服务', 'Microservice', 'Independently deployable service boundary.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:sandbox', 'artifact', 'sandbox', '沙盒', 'Sandbox', 'Isolated or untrusted-code execution runtime.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
