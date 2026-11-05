-- Daily impression/click rollup for every paid or sponsored placement: the
-- sponsor strip, homepage sponsor row, sponsor page, footer credit, model
-- credit, and hiring cards / careers links. Written by POST /api/sponsors/pulse.
--
-- One row per (day, ad_kind, ad_id, placement). `day` is the Beijing calendar
-- date (UTC+8, YYYY-MM-DD) so day/month reports line up with sponsorship
-- periods; month = substr(day, 1, 7). CTR = clicks / impressions, computed at
-- query time. `advertiser` is a stable key (never a display name, which gets
-- retitled) so one sponsor's strip, row, and job ads roll up together.
CREATE TABLE IF NOT EXISTS ad_daily_stats (
  day         TEXT NOT NULL,
  ad_kind     TEXT NOT NULL
              CHECK (ad_kind IN ('sponsor', 'job', 'company', 'static')),
  ad_id       TEXT NOT NULL,
  placement   TEXT NOT NULL,
  advertiser  TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (day, ad_kind, ad_id, placement)
);

CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_advertiser
  ON ad_daily_stats(advertiser, day);

-- Stable advertiser key for sponsorship rows. Jobs and careers links use
-- job_companies.id, so ModaLeap's recruiting sponsor cell and its job cards
-- share 'modaleap'. NULL falls back to the sponsorship id.
ALTER TABLE sponsorships ADD COLUMN advertiser_id TEXT;

UPDATE sponsorships SET advertiser_id = 'lobehub' WHERE id = 'seed-sponsor-lobehub';
UPDATE sponsorships SET advertiser_id = 'stepfun' WHERE id = 'seed-sponsor-stepfun';
UPDATE sponsorships SET advertiser_id = 'ds-harness-remote' WHERE id = 'seed-sponsor-ds-harness-remote';
UPDATE sponsorships SET advertiser_id = 'mosoo' WHERE id = 'seed-sponsor-mosoo';
UPDATE sponsorships SET advertiser_id = 'phi-browser' WHERE id = 'seed-sponsor-phi-browser';
UPDATE sponsorships SET advertiser_id = 'modaleap' WHERE id = 'sponsor-modaleap-recruiting';
UPDATE sponsorships SET advertiser_id = 'vibe42' WHERE id = 'sponsor-vibe42';
