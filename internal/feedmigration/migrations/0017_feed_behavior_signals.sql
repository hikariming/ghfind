CREATE TABLE feed.behavior_signals (
 github_id BIGINT NOT NULL REFERENCES feed.users(github_id) ON DELETE CASCADE,
 repo_key TEXT NOT NULL REFERENCES feed.projects(repo_key) ON DELETE CASCADE,
 signal TEXT NOT NULL CHECK(signal IN ('saved','outbound','qualified_dwell')),
 occurred_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(github_id,repo_key,signal)
);
CREATE INDEX feed_behavior_actor_time ON feed.behavior_signals(github_id,occurred_at DESC);
