CREATE TABLE jobs (
 id TEXT PRIMARY KEY,
 installation INTEGER NOT NULL,
 repository INTEGER,
 full_name TEXT,
 pr INTEGER,
 kind TEXT NOT NULL CHECK(kind IN ('discover','initialize','label')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0,
 created INTEGER NOT NULL,
 started INTEGER NOT NULL DEFAULT 0,
 due INTEGER NOT NULL,
 lease INTEGER NOT NULL DEFAULT 0,
 score TEXT,
 page INTEGER NOT NULL DEFAULT 1,
 result TEXT,
 updated INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(state,due,lease);
CREATE INDEX jobs_installation ON jobs(installation,updated);
CREATE TABLE sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
