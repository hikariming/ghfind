-- Seed the current public sponsor holders from src/config/sponsors.ts.
-- 2026-09-23 is the supplied Beijing calendar date; missing dates remain NULL.
INSERT OR IGNORE INTO sponsorships (
  id,
  tier,
  sponsor_name,
  sponsor_url,
  icon_url,
  mark,
  description,
  is_anonymous,
  is_perpetual,
  started_at,
  expires_at,
  created_at,
  updated_at
) VALUES
  (
    'seed-sponsor-lobehub', '夯', 'LobeHub', 'https://lobehub.com', '/lobehub.png', NULL,
    'Your Chief Agent Operator · 你的首席 Agent 操作官', 0, 1, NULL, NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'seed-sponsor-stepfun', '顶级', 'StepFun', 'https://www.stepfun.com/', '/stepfun.svg', NULL,
    NULL, 0, 1, NULL, NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'seed-sponsor-ds-harness-remote', '人上人', 'ds-harness-remote',
    'https://github.com/liguobao/ds-harness-remote', NULL, 'DSH',
    '一次连接，随时远程使用 Harness', 0, 0, 1790092800000, NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'seed-sponsor-mosoo', '人上人', 'mosoo', 'https://mosoo.ai', '/mosoo.svg', NULL,
    'Coding Agent 云上运行时', 0, 1, 1790092800000, NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  ),
  (
    'seed-sponsor-phi-browser', '人上人', 'Phi Browser',
    'https://phibrowser.com/?utm_source=ghfind&utm_medium=sponsor', '/phibrowser.png', NULL,
    '真正懂你的开源 AI 浏览器', 0, 0, 1790092800000, NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
