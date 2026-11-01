-- One row represents one sponsor tier for one sponsorship period.
-- Permanent sponsorships set is_perpetual=1 and keep expires_at NULL.
-- Timestamps are Unix milliseconds in UTC, matching the runtime's D1 schema.
CREATE TABLE IF NOT EXISTS sponsorships (
  id            TEXT PRIMARY KEY,
  tier          TEXT NOT NULL
                CHECK (tier IN ('夯', '顶级', '人上人', '友情')),
  sponsor_name  TEXT,
  sponsor_url   TEXT,
  icon_url      TEXT,
  mark          TEXT,
  description   TEXT,
  is_anonymous  INTEGER NOT NULL DEFAULT 0
                CHECK (is_anonymous IN (0, 1)),
  is_perpetual  INTEGER NOT NULL DEFAULT 0
                CHECK (is_perpetual IN (0, 1)),
  started_at    INTEGER,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (
    is_perpetual = 0 OR expires_at IS NULL
  ),
  CHECK (
    expires_at IS NULL OR started_at IS NULL OR expires_at > started_at
  ),
  CHECK (
    is_anonymous = 0 OR (
      sponsor_name IS NULL
      AND sponsor_url IS NULL
      AND icon_url IS NULL
      AND mark IS NULL
      AND description IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_sponsorships_tier_expiry
  ON sponsorships(tier, expires_at);
