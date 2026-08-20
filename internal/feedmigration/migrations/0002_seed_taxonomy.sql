INSERT INTO feed.taxonomy_versions (version, state, activated_at, note)
VALUES (1, 'active', now(), 'Initial project type and lifecycle taxonomy')
ON CONFLICT (version) DO NOTHING;

INSERT INTO feed.tag_definitions
  (id, namespace, slug, label_zh, label_en, description, status, taxonomy_version)
VALUES
  ('artifact:micro-tool', 'artifact', 'micro-tool', '微型工具', 'Micro tool', 'Small focused utility or CLI', 'canonical', 1),
  ('artifact:sdk-library', 'artifact', 'sdk-library', 'SDK/开发库', 'SDK / library', 'Reusable software library or SDK', 'canonical', 1),
  ('artifact:web-app', 'artifact', 'web-app', 'Web 应用', 'Web app', 'Browser-delivered application', 'canonical', 1),
  ('artifact:desktop-app', 'artifact', 'desktop-app', '桌面应用', 'Desktop app', 'Desktop application', 'canonical', 1),
  ('artifact:framework-platform', 'artifact', 'framework-platform', '框架/平台', 'Framework / platform', 'Framework or developer platform', 'canonical', 1),
  ('artifact:database-infra', 'artifact', 'database-infra', '数据库/基础设施', 'Database / infrastructure', 'Database or infrastructure software', 'canonical', 1),
  ('artifact:template-scaffold', 'artifact', 'template-scaffold', '模板/脚手架', 'Template / scaffold', 'Template or project scaffold', 'canonical', 1),
  ('artifact:enterprise-system', 'artifact', 'enterprise-system', '企业系统', 'Enterprise system', 'Large enterprise-oriented system', 'canonical', 1),
  ('stage:active-evolution', 'stage', 'active-evolution', '活跃演进', 'Active evolution', 'Actively gaining capabilities', 'canonical', 1),
  ('stage:stable-maintenance', 'stage', 'stable-maintenance', '稳定维护', 'Stable maintenance', 'Stable and actively maintained', 'canonical', 1),
  ('stage:feature-complete', 'stage', 'feature-complete', '功能完成', 'Feature complete', 'Intentionally complete and maintained as needed', 'canonical', 1),
  ('stage:experimental', 'stage', 'experimental', '实验阶段', 'Experimental', 'Early or experimental software', 'canonical', 1),
  ('stage:abandoned', 'stage', 'abandoned', '停止维护', 'Abandoned', 'No longer maintained', 'canonical', 1)
ON CONFLICT (id) DO NOTHING;
