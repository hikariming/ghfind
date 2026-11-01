-- Intent labels the bot added. Humans can apply the same names, so cleanup
-- removes only labels recorded here and never guesses from the label name.
CREATE TABLE triage_labels (
  repository INTEGER NOT NULL,
  number INTEGER NOT NULL,
  label TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (repository, number, label)
);
-- Who changed what, from the web admin or the API. No issue text or tokens.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository INTEGER NOT NULL,
  actor TEXT NOT NULL,
  via TEXT NOT NULL CHECK(via IN ('web','api')),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE INDEX audit_log_repository ON audit_log(repository, created);
-- A cleanup is planned (dry run), confirmed, then executed in queue steps.
-- lease doubles as "not before" while a step waits for quota.
CREATE TABLE cleanups (
  id TEXT PRIMARY KEY,
  installation INTEGER NOT NULL,
  repository INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planning','planned','running','done','failed','cancelled','expired')),
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '{}',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  lease INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT NOT NULL,
  confirmed_by TEXT,
  result TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX cleanups_repository ON cleanups(repository, created);
CREATE INDEX cleanups_active ON cleanups(state, lease);
CREATE TABLE cleanup_items (
  cleanup TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issue_label','comment','label')),
  number INTEGER,
  name TEXT,
  comment INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','skipped')),
  PRIMARY KEY (cleanup, seq)
);
-- API abuse limits: requests per GitHub account per window, and a short-lived
-- cache of permission checks so polling and repeated denials cost no GitHub
-- quota. Keys hold ids and repository names only, never tokens.
CREATE TABLE api_rate (
  key TEXT NOT NULL,
  slot INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, slot)
);
CREATE TABLE api_auth (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL
);
