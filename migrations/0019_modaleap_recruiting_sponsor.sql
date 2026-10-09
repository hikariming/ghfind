-- Explicit display priority keeps sponsorship dates independent of placement.
ALTER TABLE sponsorships ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

-- Existing featured sponsors retain their relative order after this first slot.
INSERT INTO sponsorships (
  id, tier, sponsor_name, sponsor_url, icon_url, description,
  is_anonymous, is_perpetual, started_at, expires_at,
  created_at, updated_at, display_order
) VALUES (
  'sponsor-modaleap-recruiting', '人上人', 'ModaLeap 大量岗位招聘',
  'https://www.modaleap.cn/join#jobs', '/modaleap.svg',
  '一起搞中国最夯的AI产业落地！',
  0, 0, NULL, NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  -1
);
