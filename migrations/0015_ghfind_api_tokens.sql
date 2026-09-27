CREATE TABLE IF NOT EXISTS ghfind_api_tokens (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ghfind_api_tokens_owner
  ON ghfind_api_tokens(github_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghfind_api_tokens_active_owner
  ON ghfind_api_tokens(github_id, revoked_at, created_at DESC);
