-- Vibe42 (vibe42.ai) takes mosoo's homepage slot, third in the 人上人 row:
-- ModaLeap (-1) → ds-harness-remote (0) → Vibe42 (0) → Phi Browser (1).
-- mosoo is expired rather than deleted so the placement history stays; the
-- table forbids an expiry on a perpetual row, so is_perpetual is cleared too.
UPDATE sponsorships
SET is_perpetual = 0,
    expires_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'seed-sponsor-mosoo';

UPDATE sponsorships
SET display_order = 1,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'seed-sponsor-phi-browser';

INSERT INTO sponsorships (
  id, tier, sponsor_name, sponsor_url, icon_url, description,
  is_anonymous, is_perpetual, started_at, expires_at,
  created_at, updated_at, display_order
) VALUES (
  'sponsor-vibe42', '人上人', 'Vibe42',
  'https://vibe42.ai/?utm_source=ghfind&utm_medium=sponsor', '/vibe42.svg',
  '掏出手机，随时指挥你的 Coding Agent',
  0, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  0
);

INSERT OR IGNORE INTO sponsorship_translations (sponsorship_id, locale, sponsor_name, description) VALUES
  ('sponsor-vibe42', 'en', NULL, 'Command your coding agents from your phone'),
  ('sponsor-vibe42', 'zh', NULL, '掏出手机，随时指挥你的 Coding Agent'),
  ('sponsor-vibe42', 'ja', NULL, 'スマホから、いつでも Coding Agent を操ろう'),
  ('sponsor-vibe42', 'ko', NULL, '휴대폰으로 언제든 코딩 Agent를 지휘하세요'),
  ('sponsor-vibe42', 'es', NULL, 'Dirige tus agentes de código desde el móvil'),
  ('sponsor-vibe42', 'pt', NULL, 'Comande seus agentes de código pelo celular'),
  ('sponsor-vibe42', 'id', NULL, 'Kendalikan coding agent dari ponselmu'),
  ('sponsor-vibe42', 'vi', NULL, 'Điều khiển coding agent ngay trên điện thoại'),
  ('sponsor-vibe42', 'ar', NULL, 'وجّه وكلاء البرمجة من هاتفك في أي وقت');
