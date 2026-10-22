-- Discover partition canonical tags (taxonomy_version remains 1; no FEED_TAXONOMY_VERSION bump).
-- Mirrors migrations-feed/0013_feed_discover_copy_fields.sql tag seed for D1/Postgres parity.
INSERT INTO feed.tag_definitions
  (id, namespace, slug, label_zh, label_en, description, status, taxonomy_version)
VALUES
  ('use_case:ai-agent', 'use_case', 'ai-agent', '智能体', 'AI agent', 'Autonomous or tool-using AI agent workflows.', 'canonical', 1),
  ('use_case:agent-skill', 'use_case', 'agent-skill', 'Agent 技能', 'Agent skill', 'Reusable skill/plugin packs for coding agents.', 'canonical', 1),
  ('artifact:microservice', 'artifact', 'microservice', '微服务', 'Microservice', 'Independently deployable service boundary.', 'canonical', 1),
  ('artifact:sandbox', 'artifact', 'sandbox', '沙盒', 'Sandbox', 'Isolated or untrusted-code execution runtime.', 'canonical', 1)
ON CONFLICT (id) DO NOTHING;
