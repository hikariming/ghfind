-- Generated from the runtime ensureSchema (db.ts + project-analysis-db.ts)
-- by tmp/schema-dump.test.ts. Regenerate rather than hand-editing.

CREATE TABLE account_lookup_limits (
             username        TEXT NOT NULL,
             ip_hash         TEXT NOT NULL,
             last_counted_at INTEGER NOT NULL,
             PRIMARY KEY (username, ip_hash)
           );
CREATE TABLE account_stats (
             username        TEXT PRIMARY KEY,
             lookup_count    INTEGER NOT NULL DEFAULT 0,
             first_lookup_at INTEGER NOT NULL,
             last_lookup_at  INTEGER NOT NULL
           );
CREATE TABLE blog_comments (
             id                TEXT PRIMARY KEY,
             post_slug         TEXT NOT NULL,
             body              TEXT NOT NULL,
             author_kind       TEXT NOT NULL,
             author_github_id  INTEGER,
             author_login      TEXT,
             author_avatar_url TEXT,
             hidden            INTEGER NOT NULL DEFAULT 0,
             created_at        INTEGER NOT NULL
           );
CREATE TABLE campaign_participants (
             campaign  TEXT NOT NULL,
             username  TEXT NOT NULL,
             joined_at INTEGER NOT NULL,
             PRIMARY KEY (campaign, username)
           );
CREATE TABLE developer_facets (
             username    TEXT NOT NULL,
             facet_type  TEXT NOT NULL,
             facet_value TEXT NOT NULL,
             weight      REAL NOT NULL DEFAULT 0,
             PRIMARY KEY (username, facet_type, facet_value)
           );
CREATE TABLE follows (
             follower_github_id INTEGER NOT NULL,
             target_username    TEXT NOT NULL,
             created_at         INTEGER NOT NULL,
             PRIMARY KEY (follower_github_id, target_username)
           );
CREATE TABLE profile_comments (
             id                TEXT PRIMARY KEY,
             target_username   TEXT NOT NULL,
             body              TEXT NOT NULL,
             author_kind       TEXT NOT NULL,
             author_github_id  INTEGER,
             author_login      TEXT,
             author_avatar_url TEXT,
             hidden            INTEGER NOT NULL DEFAULT 0,
             created_at        INTEGER NOT NULL
           );
CREATE TABLE profile_danmaku (
             username   TEXT PRIMARY KEY,
             lines      TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             version    TEXT
           );
CREATE TABLE profile_reactions (
             target_username  TEXT NOT NULL,
             voter_github_id  INTEGER NOT NULL,
             voter_login      TEXT NOT NULL,
             reaction         TEXT NOT NULL,
             created_at       INTEGER NOT NULL,
             updated_at       INTEGER NOT NULL,
             PRIMARY KEY (target_username, voter_github_id)
           );
CREATE TABLE profile_snapshots (
             id            TEXT PRIMARY KEY,
             username      TEXT NOT NULL,
             scanned_at    INTEGER NOT NULL,
             top_repos     TEXT,
             impact_repos  TEXT,
             verified_prs  TEXT,
             metrics       TEXT,
             pinned_repos  TEXT,
             organizations TEXT,
             signature_work TEXT,
             scan_version  TEXT
           );
CREATE TABLE project_analysis_runs (
             id TEXT PRIMARY KEY,
             repo_key TEXT NOT NULL,
             canonical_url TEXT NOT NULL,
             requested_ref TEXT,
             resolved_commit_sha TEXT,
             active_key TEXT UNIQUE,
             idempotency_key TEXT NOT NULL UNIQUE,
             status TEXT NOT NULL,
             phase TEXT NOT NULL,
             progress INTEGER NOT NULL DEFAULT 0,
             activities_json TEXT NOT NULL DEFAULT '[]',
             mosoo_agent_id TEXT,
             mosoo_thread_id TEXT UNIQUE,
             mosoo_run_id TEXT,
             schema_version TEXT NOT NULL,
             rubric_version TEXT NOT NULL,
             agent_version TEXT NOT NULL,
             skill_version TEXT NOT NULL,
             verification_level TEXT,
             analysis_json TEXT,
             report_markdown TEXT,
             evidence_json TEXT,
             analysis_sha256 TEXT,
             report_sha256 TEXT,
             evidence_sha256 TEXT,
             error_code TEXT,
             error_message TEXT,
             create_attempts INTEGER NOT NULL DEFAULT 0,
             create_retry_at INTEGER,
             created_at INTEGER NOT NULL,
             started_at INTEGER,
             completed_at INTEGER,
             updated_at INTEGER NOT NULL
           );
CREATE TABLE project_assessments (
             repo_key TEXT PRIMARY KEY,
             latest_analysis_id TEXT NOT NULL,
             project_type TEXT NOT NULL,
             lifecycle TEXT NOT NULL,
             product_score REAL NOT NULL,
             pain_score REAL NOT NULL,
             effectiveness_score REAL NOT NULL,
             experience_score REAL NOT NULL,
             value_density_score REAL NOT NULL,
             community_strength REAL NOT NULL DEFAULT 0,
             confidence REAL NOT NULL,
             verification_level TEXT NOT NULL,
             unknowns_json TEXT NOT NULL,
             risks_json TEXT NOT NULL,
             exposure_band TEXT NOT NULL,
             stars INTEGER,
             treasure_eligible INTEGER NOT NULL DEFAULT 0,
             classic_eligible INTEGER NOT NULL DEFAULT 0,
             resolved_commit_sha TEXT NOT NULL,
             rubric_version TEXT NOT NULL,
             analyzed_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
           );
CREATE TABLE public_scan_commit_candidates (
             run_id       TEXT NOT NULL,
             sha          TEXT NOT NULL,
             repo_key     TEXT NOT NULL,
             owner_login  TEXT,
             stars        INTEGER NOT NULL DEFAULT 0,
             is_private   INTEGER NOT NULL DEFAULT 0,
             is_fork      INTEGER NOT NULL DEFAULT 0,
             authored_at  TEXT,
             PRIMARY KEY(run_id, sha, repo_key)
           );
CREATE TABLE public_scan_commit_repo_facts (
             run_id             TEXT NOT NULL,
             repo_key           TEXT NOT NULL,
             owner_login        TEXT,
             stars              INTEGER NOT NULL DEFAULT 0,
             is_private         INTEGER NOT NULL DEFAULT 0,
             is_fork            INTEGER NOT NULL DEFAULT 0,
             commits            INTEGER NOT NULL DEFAULT 0,
             active_years       INTEGER NOT NULL DEFAULT 0,
             first_committed_at TEXT,
             last_committed_at  TEXT,
             source             TEXT NOT NULL,
             evidence_shas      TEXT NOT NULL DEFAULT '[]',
             PRIMARY KEY(run_id, repo_key)
           );
CREATE TABLE public_scan_commit_verification_work (
             run_id              TEXT NOT NULL,
             repo_key            TEXT NOT NULL,
             range_from          TEXT NOT NULL,
             range_to            TEXT NOT NULL,
             owner_login         TEXT,
             stars               INTEGER NOT NULL DEFAULT 0,
             is_private          INTEGER NOT NULL DEFAULT 0,
             is_fork             INTEGER NOT NULL DEFAULT 0,
             page                INTEGER NOT NULL DEFAULT 1,
             state               TEXT NOT NULL CHECK(state IN ('queued', 'complete', 'superseded')),
             commit_count        INTEGER NOT NULL DEFAULT 0,
             first_committed_at  TEXT,
             last_committed_at   TEXT,
             active_years        TEXT NOT NULL DEFAULT '[]',
             evidence_shas       TEXT NOT NULL DEFAULT '[]',
             PRIMARY KEY(run_id, repo_key, range_from, range_to)
           );
CREATE TABLE public_scan_execution_leases (
             slot             INTEGER PRIMARY KEY,
             job_id           TEXT,
             lease_token      TEXT,
             lease_expires_at INTEGER NOT NULL DEFAULT 0
           );
CREATE TABLE public_scan_execution_settings (
             singleton         INTEGER PRIMARY KEY CHECK(singleton = 1),
             capacity          INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 4),
             updated_at        INTEGER NOT NULL
           );
CREATE TABLE public_scan_jobs (
             id                 TEXT PRIMARY KEY,
             run_id             TEXT NOT NULL,
             username           TEXT NOT NULL,
             score_version      TEXT NOT NULL,
             collection_version TEXT NOT NULL,
             state              TEXT NOT NULL CHECK(state IN ('queued', 'running', 'failed', 'complete')),
             phase              TEXT NOT NULL,
             payload            TEXT NOT NULL DEFAULT '{}',
             attempt_count      INTEGER NOT NULL DEFAULT 0,
             next_run_at        INTEGER NOT NULL,
             lease_token        TEXT,
             lease_expires_at   INTEGER,
             created_at         INTEGER NOT NULL,
             updated_at         INTEGER NOT NULL
           );
CREATE TABLE public_scan_owned_repo_facts (
             run_id       TEXT NOT NULL,
             repo_key     TEXT NOT NULL,
             name         TEXT NOT NULL,
             owner_login  TEXT,
             stars        INTEGER NOT NULL DEFAULT 0,
             forks        INTEGER NOT NULL DEFAULT 0,
             open_issues  INTEGER NOT NULL DEFAULT 0,
             size         INTEGER NOT NULL DEFAULT 0,
             language     TEXT,
             description  TEXT,
             pushed_at    TEXT,
             topics       TEXT NOT NULL DEFAULT '[]',
             PRIMARY KEY(run_id, repo_key)
           );
CREATE TABLE public_scan_pr_facts (
             run_id             TEXT NOT NULL,
             pull_request_id    TEXT NOT NULL,
             source             TEXT NOT NULL CHECK(source IN ('native_merged', 'workflow_landed', 'closed')),
             repo_key           TEXT,
             owner_login        TEXT,
             stars              INTEGER NOT NULL DEFAULT 0,
             is_private         INTEGER NOT NULL DEFAULT 0,
             is_fork            INTEGER NOT NULL DEFAULT 0,
             created_at         TEXT,
             merged_at          TEXT,
             closed_at          TEXT,
             title              TEXT,
             additions          INTEGER,
             deletions          INTEGER,
             changed_files      INTEGER,
             labels             TEXT,
             PRIMARY KEY(run_id, pull_request_id)
           );
CREATE TABLE public_scan_rate_windows (
             bucket           TEXT NOT NULL,
             window_started   INTEGER NOT NULL,
             count            INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY(bucket, window_started)
           );
CREATE TABLE public_scan_runs (
             id                 TEXT PRIMARY KEY,
             username           TEXT NOT NULL,
             score_version      TEXT NOT NULL,
             collection_version TEXT NOT NULL,
             state              TEXT NOT NULL CHECK(state IN ('queued', 'running', 'complete_public', 'partial_public', 'failed')),
             coverage           TEXT NOT NULL CHECK(coverage IN ('partial_public', 'complete_public')),
             source_status      TEXT NOT NULL DEFAULT '{}',
             quick_scan         TEXT,
             snapshot           TEXT,
             snapshot_hash      TEXT,
             started_at         INTEGER NOT NULL,
             completed_at       INTEGER,
             updated_at         INTEGER NOT NULL,
             last_error         TEXT
           );
CREATE TABLE public_scan_step_metrics (
             collection_version TEXT NOT NULL,
             phase              TEXT NOT NULL,
             outcome            TEXT NOT NULL CHECK(outcome IN ('continued', 'complete', 'failed_retrying', 'failed_terminal', 'slot_busy')),
             step_count         INTEGER NOT NULL DEFAULT 0,
             total_duration_ms  INTEGER NOT NULL DEFAULT 0,
             max_duration_ms    INTEGER NOT NULL DEFAULT 0,
             updated_at         INTEGER NOT NULL,
             PRIMARY KEY(collection_version, phase, outcome)
           );
CREATE TABLE public_scan_worker_metrics (
             singleton            INTEGER PRIMARY KEY CHECK(singleton = 1),
             last_started_at       INTEGER,
             last_success_at       INTEGER,
             last_duration_ms      INTEGER,
             last_processed        INTEGER NOT NULL DEFAULT 0,
             last_failed_steps     INTEGER NOT NULL DEFAULT 0,
             consecutive_failures  INTEGER NOT NULL DEFAULT 0,
             updated_at            INTEGER NOT NULL
           );
CREATE TABLE repo_developers (
             repo_key   TEXT NOT NULL,
             username   TEXT NOT NULL,
             relation   TEXT NOT NULL CHECK(relation IN ('owner','contributor')),
             commits    INTEGER,
             prs        INTEGER,
             weight     REAL NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY (repo_key, username, relation)
           );
CREATE TABLE repos (
             repo_key        TEXT PRIMARY KEY,
             name_with_owner TEXT NOT NULL,
             owner_login     TEXT NOT NULL,
             name            TEXT NOT NULL,
             description     TEXT,
             stars           INTEGER NOT NULL DEFAULT 0,
             forks           INTEGER,
             language        TEXT,
             topics          TEXT,
             updated_at      INTEGER NOT NULL
           );
CREATE TABLE score_snapshots (
             id            TEXT PRIMARY KEY,
             username      TEXT NOT NULL,
             display_name  TEXT,
             avatar_url    TEXT,
             profile_url   TEXT,
             final_score   REAL NOT NULL,
             tier          TEXT NOT NULL,
             tags          TEXT,
             roast_line    TEXT,
             bot_score     REAL,
             sub_scores    TEXT,
             score_version TEXT NOT NULL,
             roast_version TEXT NOT NULL,
             roast_lang    TEXT NOT NULL CHECK(roast_lang IN ('zh', 'en')),
             generated_at  INTEGER NOT NULL
           );
CREATE TABLE scores (
             username     TEXT PRIMARY KEY,
             display_name TEXT,
             avatar_url   TEXT,
             profile_url  TEXT,
             final_score  REAL NOT NULL,
             tier         TEXT NOT NULL,
             tags         TEXT,
             bot_score    REAL,
             sub_scores   TEXT,
             roast        TEXT,
             roast_line   TEXT,
             score_write_token TEXT,
             score_source_collection_version TEXT,
             score_source_snapshot_hash TEXT,
             hidden       INTEGER NOT NULL DEFAULT 0,
             scanned_at   INTEGER NOT NULL
           , roast_en TEXT, score_version TEXT, roast_version TEXT, roast_en_version TEXT, prev_score REAL, prev_scanned_at INTEGER, followers INTEGER, total_stars INTEGER);
CREATE TABLE treasure_entries (
             id TEXT PRIMARY KEY,
             repo_key TEXT NOT NULL,
             analysis_id TEXT NOT NULL,
             status TEXT NOT NULL,
             selected_at INTEGER NOT NULL,
             product_score_snapshot REAL NOT NULL,
             confidence_snapshot REAL NOT NULL,
             verification_level_snapshot TEXT NOT NULL,
             stars_snapshot INTEGER,
             exposure_snapshot TEXT NOT NULL,
             reason TEXT NOT NULL,
             resolved_commit_sha TEXT NOT NULL,
             graduated_at INTEGER,
             removed_at INTEGER,
             removed_reason TEXT
           );
CREATE TABLE users (
             github_id   INTEGER PRIMARY KEY,
             login       TEXT NOT NULL,
             name        TEXT,
             avatar_url  TEXT,
             created_at  INTEGER NOT NULL,
             last_login  INTEGER NOT NULL
           );
CREATE TABLE vs_matchups (
             handle_a       TEXT NOT NULL,
             handle_b       TEXT NOT NULL,
             winner         TEXT,
             bucket         TEXT NOT NULL,
             gap            REAL NOT NULL,
             score_a        REAL NOT NULL,
             score_b        REAL NOT NULL,
             verdict        TEXT,
             advice         TEXT,
             verdict_source TEXT,
             view_count     INTEGER NOT NULL DEFAULT 0,
             created_at     INTEGER NOT NULL,
             updated_at     INTEGER NOT NULL,
             PRIMARY KEY (handle_a, handle_b)
           );
CREATE INDEX idx_account_lookup_limits_counted_user
             ON account_lookup_limits(last_counted_at, username);
CREATE INDEX idx_account_lookup_limits_last_counted
             ON account_lookup_limits(last_counted_at);
CREATE INDEX idx_account_stats_heat
             ON account_stats(lookup_count DESC);
CREATE INDEX idx_blog_comments_post_created
             ON blog_comments(post_slug, created_at DESC);
CREATE INDEX idx_campaign_participants_user
             ON campaign_participants(username, campaign);
CREATE INDEX idx_developer_facets_lookup
             ON developer_facets(facet_type, facet_value, username);
CREATE INDEX idx_follows_target ON follows(target_username);
CREATE INDEX idx_profile_comments_target_created
             ON profile_comments(target_username, created_at DESC);
CREATE INDEX idx_profile_reactions_target_reaction
             ON profile_reactions(target_username, reaction);
CREATE INDEX idx_profile_snapshots_username_scanned
             ON profile_snapshots(username, scanned_at DESC);
CREATE INDEX idx_project_analysis_runs_repo_created
             ON project_analysis_runs(repo_key, created_at DESC);
CREATE INDEX idx_project_analysis_runs_status_updated
             ON project_analysis_runs(status, updated_at);
CREATE INDEX idx_project_assessments_classic
             ON project_assessments(classic_eligible, product_score DESC, confidence DESC);
CREATE INDEX idx_project_assessments_treasure
             ON project_assessments(treasure_eligible, product_score DESC, confidence DESC);
CREATE INDEX idx_public_scan_commit_candidates_run_repo
             ON public_scan_commit_candidates(run_id, repo_key, authored_at);
CREATE INDEX idx_public_scan_commit_facts_run
             ON public_scan_commit_repo_facts(run_id);
CREATE INDEX idx_public_scan_commit_work_ready
             ON public_scan_commit_verification_work(run_id, state, repo_key);
CREATE UNIQUE INDEX idx_public_scan_jobs_active_user_collection
             ON public_scan_jobs(username, collection_version)
             WHERE state IN ('queued', 'running');
CREATE UNIQUE INDEX idx_public_scan_jobs_active_user_version
             ON public_scan_jobs(username, score_version, collection_version)
             WHERE state IN ('queued', 'running');
CREATE INDEX idx_public_scan_jobs_collection_ready
             ON public_scan_jobs(collection_version, state, next_run_at);
CREATE INDEX idx_public_scan_jobs_ready
             ON public_scan_jobs(state, next_run_at);
CREATE INDEX idx_public_scan_owned_repos_run_stars
             ON public_scan_owned_repo_facts(run_id, stars DESC);
CREATE INDEX idx_public_scan_pr_facts_run_repo
             ON public_scan_pr_facts(run_id, repo_key);
CREATE INDEX idx_public_scan_runs_state
             ON public_scan_runs(state, updated_at);
CREATE INDEX idx_public_scan_runs_user_collection
             ON public_scan_runs(username, collection_version, updated_at DESC);
CREATE INDEX idx_public_scan_runs_user_collection_completed
             ON public_scan_runs(username, collection_version, completed_at DESC, id DESC);
CREATE INDEX idx_public_scan_runs_user_collection_started
             ON public_scan_runs(username, collection_version, started_at DESC, id DESC);
CREATE INDEX idx_public_scan_runs_user_version
             ON public_scan_runs(username, score_version, collection_version, updated_at DESC);
CREATE INDEX idx_repo_developers_user ON repo_developers(username);
CREATE INDEX idx_repos_owner ON repos(owner_login);
CREATE INDEX idx_repos_stars ON repos(stars DESC);
CREATE INDEX idx_score_snapshots_username_generated
             ON score_snapshots(username, generated_at DESC);
CREATE INDEX idx_scores_hidden_score
             ON scores(hidden, final_score DESC);
CREATE INDEX idx_scores_score ON scores(final_score DESC);
CREATE UNIQUE INDEX idx_treasure_entries_one_active
             ON treasure_entries(repo_key) WHERE status = 'active';
CREATE INDEX idx_treasure_entries_repo_selected
             ON treasure_entries(repo_key, selected_at DESC);
CREATE UNIQUE INDEX idx_users_login ON users(login);
CREATE INDEX idx_vs_matchups_a ON vs_matchups(handle_a, updated_at DESC);
CREATE INDEX idx_vs_matchups_b ON vs_matchups(handle_b, updated_at DESC);
CREATE INDEX idx_vs_matchups_hot ON vs_matchups(view_count DESC);
