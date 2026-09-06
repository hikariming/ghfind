-- Preserve the immediately previous public release before v10 materialization
-- replaces the one-row `scores` record. This table is read-only at request time:
-- it is never joined into rankings and is never a source for v10 writes.
CREATE TABLE IF NOT EXISTS score_release_fallbacks (
             username           TEXT NOT NULL,
             score_version      TEXT NOT NULL,
             collection_version TEXT NOT NULL,
             display_name       TEXT,
             avatar_url         TEXT,
             profile_url        TEXT,
             final_score        REAL NOT NULL,
             tier               TEXT NOT NULL,
             tags               TEXT,
             roast_line         TEXT,
             roast              TEXT,
             roast_en           TEXT,
             roast_version      TEXT,
             roast_en_version   TEXT,
             bot_score          REAL,
             sub_scores         TEXT,
             risk_assessment    TEXT,
             risk_notes         TEXT,
             snapshot           TEXT,
             snapshot_hash      TEXT,
             source_status      TEXT NOT NULL DEFAULT '{}',
             scanned_at         INTEGER NOT NULL,
             captured_at        INTEGER NOT NULL,
             PRIMARY KEY (username, score_version, collection_version)
           );
CREATE INDEX IF NOT EXISTS idx_score_release_fallbacks_username
             ON score_release_fallbacks(username, captured_at DESC);

-- Back up rows that still carry the previous formal v9 score. The best matching
-- complete v4 run supplies the immutable scan evidence when it exists; a score
-- and report remain readable even if the old run was already pruned.
INSERT OR IGNORE INTO score_release_fallbacks
            (username, score_version, collection_version, display_name, avatar_url,
             profile_url, final_score, tier, tags, roast_line, roast, roast_en,
             roast_version, roast_en_version, bot_score, sub_scores, risk_assessment,
             risk_notes, snapshot, snapshot_hash, source_status, scanned_at, captured_at)
SELECT s.username, s.score_version, 'v4', s.display_name, s.avatar_url,
       s.profile_url, s.final_score, s.tier, s.tags, s.roast_line, s.roast,
       s.roast_en, s.roast_version, s.roast_en_version, s.bot_score, s.sub_scores,
       s.risk_assessment, s.risk_notes, r.snapshot, r.snapshot_hash,
       COALESCE(r.source_status, '{}'), s.scanned_at,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM scores s
LEFT JOIN public_scan_runs r ON r.id = (
  SELECT candidate.id
  FROM public_scan_runs candidate
  WHERE candidate.username = s.username
    AND candidate.score_version = 'v9'
    AND candidate.collection_version = 'v4'
    AND candidate.state = 'complete_public'
    AND candidate.coverage = 'complete_public'
    AND candidate.snapshot IS NOT NULL
    AND candidate.snapshot_hash IS NOT NULL
    AND length(candidate.snapshot_hash) = 64
    AND candidate.snapshot_hash NOT GLOB '*[^0-9a-f]*'
    AND candidate.completed_at IS NOT NULL
  ORDER BY candidate.completed_at DESC, candidate.id DESC
  LIMIT 1
)
WHERE s.hidden = 0
  AND s.score_version = 'v9'
  AND s.score_source_collection_version = 'v4';
