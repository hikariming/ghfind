# Durable Public Scan Design

## Problem

The synchronous GitHub scan is intentionally bounded for ordinary accounts, but
the bound is not a reliable representation of prolific contributors. In
particular, a user can have more native merged pull requests than the current
sample collects, and GitHub can reject the contribution graph query that backs
commit-only contribution attribution with `RESOURCE_LIMITS_EXCEEDED`.

The product must never turn incomplete source coverage into a negative factual
claim or a final roast. At the same time, repeatedly rescanning an entire
history on every profile visit would be too expensive and would exceed serverless
request budgets.

## Goals

- Preserve the existing deterministic scoring formulas and judge semantics.
- Collect all publicly attributable native merged PRs, rather than a fixed
  recent sample, for accounts that need historical enrichment.
- Recover public default-branch commit-only contribution when GitHub's
  `commitContributionsByRepository` aggregation is unavailable.
- Persist resumable scan inputs and versioned output in Turso.
- Keep normal cached profile reads cheap and keep an older complete report
  visible while a refresh runs.
- Make the coverage used by score, ranking, and writer explicit and auditable.

## Non-goals

- Claiming access to private repositories or contributions that GitHub cannot
  associate with the account.
- Replacing the deterministic score with an LLM decision.
- Performing a full historical crawl inside a page render or public API request.

## Coverage Contract

Every scan run has one of these states:

| State | Meaning | May update score, rank, and roast? |
| --- | --- | --- |
| `queued` / `running` | Collection is in progress. | No. Keep the last complete snapshot. |
| `complete_public` | Every required public source for this scan version completed. | Yes. |
| `partial_public` | A source remains unavailable after bounded retries. | No new final result. |
| `failed` | The job cannot currently progress. | No. Keep the last complete snapshot. |

`complete_public` means complete within the public data GitHub attributes to the
login. It does not include private activity or commits authored with an email
that GitHub does not associate with that login.

## User Request Path

1. Resolve the latest `complete_public` snapshot for the current scoring and
   collection versions.
2. If it is fresh, return it directly. This remains the common path for normal
   users and does not call GitHub or an LLM.
3. If it is stale, atomically create or reuse a per-user scan job. Return the
   prior complete snapshot with a refresh indicator.
4. If no complete snapshot exists, expose factual quick-scan progress only.
   Do not write a leaderboard row, percentile, final score, or roast until the
   job publishes a `complete_public` snapshot.

The freshness interval is a policy value. It is an eligibility window for an
incremental check, not permission to repeat a full historical crawl.

## Durable Data Model

The worker persists each stage so it can continue after a serverless timeout or
delivery retry.

### `scan_runs`

- `id`, `username`, `score_version`, `collection_version`
- `state`, `coverage`, `source_status_json`
- `input_hash`, `started_at`, `completed_at`, `last_error`

### `scan_jobs`

- One active job per `username + collection_version`.
- `phase`, `payload_json`, `attempt_count`, `next_run_at`
- `lease_token`, `lease_expires_at` for worker ownership and idempotency.

### `scan_pr_facts`

- One immutable row per `run_id + pull_request_node_id`.
- Repository identity, native state, timestamps, change-size fields, title,
  label evidence, and source (`native_merged` or `workflow_landed`).

### `scan_commit_repo_facts`

- Per-run, per-repository verified default-branch contribution aggregate.
- Count, first/last commit timestamps, source, repository metadata, and bounded
  evidence SHA samples.

### `scan_snapshots`

- The normalized input used by the deterministic scorer, its output, and a
  stable `snapshot_hash` used to key writer output.

Raw PR facts are durable. High-volume commit discovery detail can be compressed
or expired after a retention period once the verified per-repository aggregate
and evidence samples have been retained.

## Collection Phases

### 1. Quick facts

Collect the existing account profile, original repositories, contribution
totals, calendar, and lightweight samples. This decides whether enrichment is
needed but does not become a final historical-impact claim by itself.

Historical enrichment is required when a resource limit occurs, the account has
more than the native PR sample limit, a prior snapshot is incomplete, or the
collection version changes.

### 2. Original repository inventory

Cursor-paginate all owner, non-fork repositories and persist the fields already
used by original-project-quality scoring. Existing quality filters still exclude
WIP, profile configuration, empty, and low-signal projects from representative
work. Pagination only removes an arbitrary inventory limit.

### 3. Native merged PR inventory

Cursor-paginate `pullRequests(states: MERGED, first: 100, after: cursor)` until
completion. Persist a page before advancing the cursor. Repository impact is
then aggregated from all native merged PR facts, not from the recent sample.

### 4. Workflow-landed inventory

Cursor-paginate closed PR candidates with minimal label fields. Only candidates
with the exact official workflow label and verified closing conditions are
stored as `workflow_landed`. They remain separate from GitHub-native merges in
both the score input and writer wording.

### 5. Commit-only recovery

Use GitHub's contribution graph aggregation when it succeeds. When it returns a
resource limit:

1. Search public commit candidates using `author:<login>` and bounded
   `author-date` time intervals.
2. Recursively split an interval when its search result set is too large to
   page safely.
3. Group candidates by repository.
4. List commits from each repository's default branch with the same author and
   time window, then persist only the verified aggregate.

Search discovers candidates; it is not score evidence. Default-branch
verification prevents unmerged or non-default-branch commits from inflating
ecosystem impact.

## Incremental Refresh

The first qualifying run performs historical backfill. Later refreshes use the
last completed watermark and fetch only new records, with a small overlapping
time window to tolerate delayed GitHub indexing. Upserts by node id / commit
identity make overlap safe.

A score or writer version change recomputes from persisted facts when the input
schema is compatible. It does not automatically trigger a GitHub history crawl.
Only collection-schema changes or incomplete coverage require source collection
again.

## Queue, Limits, and Failure Handling

Use a durable queue such as Upstash QStash, with Turso as the source of truth.
Each delivery acquires a short database lease, processes a bounded number of
GitHub pages, stores progress, and schedules the next delivery. The public route
only enqueues work.

- Per-user active-job uniqueness avoids duplicate scans.
- A global GitHub token bucket and low worker concurrency protect API quota.
- Each phase has bounded retries with exponential backoff.
- Redis is an optimization, never the sole correctness lock; the Turso job lease
  remains authoritative when Redis is unavailable.
- A failed job preserves the last `complete_public` result and records a
  diagnostic status instead of publishing partial facts as a new score.

## Publication Rules

Only a `complete_public` run may atomically:

1. build the score input;
2. execute the unchanged deterministic score;
3. update the leaderboard and percentile row;
4. write the snapshot;
5. generate or replay roast text keyed by `snapshot_hash`, writer version, and
   language.

Writer prompts receive source coverage. They must not infer a lack of impact,
or quote a bounded sample as a total, when coverage is partial.

## Delivery Plan

1. Add run/job schema, job lease helpers, source coverage types, and tests.
2. Move full native merged PR pagination into a resumable worker phase.
3. Gate publication on complete snapshots while preserving stale complete pages.
4. Add full workflow-landed pagination and verification.
5. Add commit-search partitioning plus default-branch verification.
6. Add incremental watermarks, queue delivery authentication, observability,
   rate limits, and production dashboards.
7. Verify with ordinary accounts, 300+ PR accounts, commit-only accounts,
   resource-limit accounts, duplicate delivery, Redis outage, queue outage, and
   version-rollout cases.
