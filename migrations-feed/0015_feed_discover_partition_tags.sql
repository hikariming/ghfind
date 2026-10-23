-- Discover partition canonical tags, split out of 0013 so the schema part can
-- ship under the 0012 writer fence. This DML is aborted by the fence when run as a
-- plain migration in production, so it is NOT in the production schema release;
-- production uses docs/operations/feed-0015-partition-tags-operator.md (owner sign-off).
-- INSERT OR IGNORE: idempotent where the original 0013 already seeded these rows.
-- Discover partition canonical tags (keep taxonomy version=1 until gated v2 rollout).
INSERT OR IGNORE INTO feed_tag_definitions
  (id, namespace, slug, label_zh, label_en, description, status, taxonomy_version, created_at, updated_at)
VALUES
  ('use_case:ai-agent', 'use_case', 'ai-agent', '智能体', 'AI agent', 'Autonomous or tool-using AI agent workflows.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('use_case:agent-skill', 'use_case', 'agent-skill', 'Agent 技能', 'Agent skill', 'Reusable skill/plugin packs for coding agents.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:microservice', 'artifact', 'microservice', '微服务', 'Microservice', 'Independently deployable service boundary.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('artifact:sandbox', 'artifact', 'sandbox', '沙盒', 'Sandbox', 'Isolated or untrusted-code execution runtime.', 'canonical', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
