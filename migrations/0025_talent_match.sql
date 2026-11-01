-- Talent Match (docs/plans/2026-10-12-talent-match-report.md): structured
-- candidate profiles, generated reports, and structured job requirements.
-- Timestamps are Unix milliseconds in UTC. Raw résumé text is never stored:
-- only the extracted profile_json, which the owner can delete with their reports.

-- One current structured profile per GitHub account (TalentProfile JSON).
CREATE TABLE IF NOT EXISTS talent_match_profiles (
  github_id      INTEGER PRIMARY KEY,
  login          TEXT NOT NULL,
  profile_json   TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  -- Vectorize id; NULL until the profile is embedded.
  vector_id      TEXT,
  opted_in       INTEGER NOT NULL DEFAULT 0 CHECK (opted_in IN (0, 1)),
  schema_version INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Generated reports. Also the quota ledger: a month's quota is the count of
-- the owner's done, non-BYO-key candidate reports created in that UTC month.
CREATE TABLE IF NOT EXISTS talent_reports (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('candidate', 'company')),
  input_hash    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  byo_key       INTEGER NOT NULL DEFAULT 0 CHECK (byo_key IN (0, 1)),
  -- Match results plus the report copy (CandidateReport / CompanyReport JSON).
  result_json   TEXT,
  match_version INTEGER NOT NULL,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_talent_reports_quota
  ON talent_reports(github_id, kind, status, created_at);
CREATE INDEX IF NOT EXISTS idx_talent_reports_hash
  ON talent_reports(github_id, input_hash);
-- The global monthly token budget sums free-channel usage across all users.
CREATE INDEX IF NOT EXISTS idx_talent_reports_month
  ON talent_reports(byo_key, created_at);

-- Structured requirements (JobRequirement JSON), shared by hiring-board jobs
-- (id = jobs.id) and pasted JDs (id = 'jd-' || input hash, job_id NULL).
CREATE TABLE IF NOT EXISTS job_requirements (
  id               TEXT PRIMARY KEY,
  job_id           TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  requirement_json TEXT NOT NULL,
  input_hash       TEXT NOT NULL,
  vector_id        TEXT,
  schema_version   INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
