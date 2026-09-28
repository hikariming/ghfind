ALTER TABLE jobs ADD COLUMN score_context TEXT;
CREATE TABLE author_subscriptions (
 user_id INTEGER PRIMARY KEY,
 login TEXT NOT NULL,
 email TEXT NOT NULL,
 locale TEXT NOT NULL CHECK(locale IN ('en','zh')),
 unsubscribe TEXT NOT NULL UNIQUE,
 updated INTEGER NOT NULL,
 last_sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE author_emails (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','cancelled','uncertain')),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL
);
CREATE INDEX author_emails_pending ON author_emails(state,created);
CREATE TABLE email_daily_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL);
