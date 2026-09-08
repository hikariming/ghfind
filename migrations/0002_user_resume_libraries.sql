-- Cloud copy of a signed-in user's résumé library (see db.ts ensureSchema).
CREATE TABLE IF NOT EXISTS user_resume_libraries (
  github_id  INTEGER PRIMARY KEY,
  login      TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
