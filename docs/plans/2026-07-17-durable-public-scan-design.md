# Durable Public Scan Design

## Status and Scope

This document describes the durable public-history scan as implemented on
`feat/durable-public-scan`, plus the explicitly deferred follow-ups. It is a
factual collection pipeline only: the deterministic score and the writer keep
their existing responsibilities.

### Constraints

- Do not add a queue SaaS, callback broker, or new external billing boundary.
- Use the existing GitHub API, Turso database, and Vercel deployment only.
- Never turn incomplete public-history coverage into a final score, leaderboard
  row, or writer claim.
- Do not make a normal 24-hour cache expiry trigger a historical GitHub crawl.
- Do not claim private activity or commits GitHub cannot attribute to the login.

## Why This Exists

The ordinary synchronous scan is intentionally bounded. It is sufficient for
most accounts, but it cannot represent an account with a long public PR history
or an account whose `commitContributionsByRepository` GraphQL resolver exceeds
GitHub's resource budget.

The failure mode to avoid is not merely a request error. A bounded recent sample
can omit old high-impact work, and an unavailable contribution graph can omit
commit-only work. Publishing a score or roast from either partial input would
make a factual claim the collector has not earned.

## Request and Cache Policy

### Ordinary account

1. Read the Redis scan cache. Its normal TTL remains 24 hours.
2. On a Redis miss, read the current `complete_public` Turso snapshot first.
3. If that snapshot exists, recompute the deterministic score from its stored
   facts, repopulate Redis, and return it. No GitHub crawl and no LLM call run.
4. Only accounts without a complete current snapshot run the bounded quick
   collector.

When a durable run is already `queued` or `running`, every entry point returns
its pending status directly. It does not clear the quick Redis entry or repeat
the bounded GitHub collector while waiting for the historical job.

Therefore, Redis expiry is an accelerator expiry, not permission to repeat a
full historical scan. Score-formula changes also recompute from the durable
facts instead of crawling GitHub again.

### Snapshot integrity, legacy data, and refresh boundaries

The current collection contract is `PUBLIC_SCAN_COLLECTION_VERSION = v3`.
A stored run is accepted as `complete_public` only when all of the following
are true:

- the row has `state=complete_public` and `coverage=complete_public`;
- all required sources (`quick`, owned repositories, native merged PRs,
  workflow-landed PRs, and commit recovery) are marked `complete`;
- the SHA-256 of the stored snapshot matches `snapshot_hash`; and
- the snapshot has every required numeric scoring fact plus the required arrays.

Missing hash, invalid JSON, incomplete source state, or a hash mismatch is
treated as incomplete data, never as a valid old score. The next eligible
request creates a new current-version job; it does not publish the suspect
snapshot. The `v3` collection-version bump similarly makes pre-v3 historical
snapshots eligible for one on-demand recollection. v3 persists public
`fork/private` metadata for commit-only recovery so those repositories cannot be
mistaken for eligible external impact. A future collector-semantic change must
bump the collection version again.

There are two distinct meanings of incremental here:

1. **Implemented:** a running collection is incremental and resumable. Every
   page cursor and fact write is durable, so the next `after()`/Cron step picks
   up where the previous one stopped instead of restarting the history crawl.
2. **Not yet implemented:** a completed snapshot does not yet have a
   watermark-based delta refresh that fetches only newly changed history. It
   also does not refresh merely because Redis expires. Collection-version
   changes or an explicit future refresh policy perform a new complete pass,
   while ordinary reads reuse the existing complete snapshot.

### Admission to durable collection

The quick collector is used only to establish basic facts and decide whether
full public-history coverage is required. It admits a durable job when any of
the following is true:

- GitHub rejected per-repository commit aggregation;
- the native merged PR aggregate is intentionally incomplete;
- native merged PR count is greater than 300;
- total PR count is greater than 600; or
- GitHub reports more public repositories than the quick two-page inventory
  fetched.

When GitHub already reports more than 300 merged PRs, the quick path skips its
known-incomplete 300-PR aggregate. This avoids both an invalid partial impact
signal and the GraphQL resource-limit failure seen on very large accounts. It
sets `merged_pr_contribution_aggregation_incomplete` and enqueues the full
paginator instead.

While no complete snapshot exists, `/api/scan`, `/api/score/:username`, and
`/api/roast` return a pending response rather than a partial final result. The
browser may poll scan status, but it does not execute collection work.

Only server-collected quick scans (the current request's GitHub result or the
server Redis cache) may seed the durable job's quick phase. A client-supplied
`/api/roast` body can be used for its immediate compatibility response, but it
never becomes a durable fact: when it needs public-history collection, the job
starts with its own server-side quick phase.

## Durable Queue and Server Execution

Turso is both the durable queue and the source of truth.

| Component | Responsibility |
| --- | --- |
| `public_scan_runs` | Run state, source coverage, quick input, final immutable snapshot, diagnostics. |
| `public_scan_jobs` | One active resumable job per username and collection version; stores phase, cursor payload, retry time, and lease. |
| `public_scan_*_facts` | Durable raw PR, owned-repository, commit-candidate, and verified commit facts. |
| execution lease table | One process-wide worker slot, so concurrent requests and Cron invocations cannot multiply GitHub usage. |
| admission window table | Atomic per-source job budget and global active-job ceiling for new historical jobs. |

Creating a new durable job is protected in the same Turso write transaction as
job insertion. Existing jobs are reused without consuming a new budget. New
jobs have a maximum of 24 active runs globally and two admissions per hashed
request source per hour. The database stores a one-way hash of the source, not
the raw IP address or Bearer credential. Reads, completed snapshots, ordinary
Redis cache hits, and status polling are never charged against this budget.

### Dispatch

1. A public API route creates or reuses the Turso job atomically.
2. The same server request calls Next.js `after()` and drains at most one
   worker step or 10 seconds. This gives a new job a server-side head start
   without making the initiating high-history request wait behind multiple
   GitHub pages; it is not browser work and does not rely on process memory.
3. `vercel.json` invokes `GET /api/internal/public-scan` every five minutes.
   The route drains at most 24 steps or 50 seconds, always resuming from the
   cursor persisted before the previous step returned.
4. Every invocation claims a database lease. An interrupted invocation expires
   after 55 seconds; a later request or Cron run safely resumes it.

There is no QStash client, callback URL, signing key, or external queue
credential. `CRON_SECRET` only authenticates Vercel's existing Cron request
using `Authorization: Bearer <secret>`.

### Deployment prerequisite

The five-minute schedule needs a Vercel plan that permits sub-daily Cron jobs.
Vercel Hobby rejects this schedule at deployment rather than silently reducing
the cadence. This is a limitation of the existing hosting plan, not a new SaaS
dependency. The deployment must provide:

```text
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
CRON_SECRET=
```

`PUBLIC_SCAN_WORKER_SECRET` is only for local, non-production route tests.

## Collection Phases

Each phase persists its result and next cursor before returning. Normal
continuations are immediately eligible for the same bounded Cron drain, so one
five-minute invocation can advance several pages. Only explicit quota/backoff
states defer `next_run_at`. Replays are idempotent through run-scoped uniqueness
keys and the execution lease.

1. **Quick facts**: bounded profile, contribution totals, recent samples, and
   current repository overview. A route may seed only an already-paid,
   server-authored GitHub result; otherwise the worker collects it once.
2. **Original repositories**: REST-page every public, non-fork owned repository.
   These are fed through the existing original-project-quality filters; full
   inventory does not make empty, profile-config, WIP, blog, or other low-signal
   repositories representative work.
3. **Native merged PRs**: GraphQL-page all public GitHub-native merged PRs in
   pages of 100, then aggregate impact from the complete durable fact set rather
   than the recent PR sample.
4. **Workflow-landed PRs**: page closed PR candidates separately. Only an exact
   official workflow label plus verified closing evidence may be counted as
   workflow-landed; they stay distinct from GitHub-native merges.
5. **Commit-only recovery**: if GitHub rejects the contribution graph, discover
   public commit candidates with `author:<login>` and date windows, split ranges
   above the Search result cap, then verify only default-branch commits before
   counting them. Public fork/private metadata is carried from candidate through
   verification and aggregation, so the existing scorer excludes ineligible
   repositories consistently with PR-derived evidence.
6. **Publication**: only after every required source is complete, materialize a
   `complete_public` snapshot, cache it in Redis, and make it available to the
   normal scan/score/roast routes.

The durable worker does not itself call an LLM or write a roast/leaderboard row.
Those existing routes consume the complete factual snapshot afterwards, so
writer style cannot affect collection or deterministic scoring.

## Quotas, Retries, and Failure Semantics

- One active job per username and collection version prevents duplicate scans.
- New jobs are admitted atomically with a global active-job ceiling and a
  source-hashed hourly budget. If Turso cannot enforce either guard, no new
  durable job is created.
- One global execution slot serializes durable work across server instances.
- Commit Search reserves a Turso-backed bucket of 20 requests per minute before
  each page; Redis is not required for that safeguard.
- A worker error retries with 5, 10, 20, then 40-second backoff. After the
  bounded attempts are exhausted, the run becomes `failed` with diagnostics.
- A failed run is retried by a later request only after a 15-minute cooldown.
- If Turso is unavailable, the API returns an unavailable response; it does not
  pretend a queue exists or publish a partial result.
- If Redis is unavailable, Turso remains the queue and source of truth. The
  system loses only cache acceleration.
- Vercel does not retry failed Cron requests itself. That is safe because the
  job row remains queued/running with its lease and the next scheduled request
  can recover it.

The UI should keep a previous `complete_public` report visible during a later
collection refresh. If no complete snapshot exists, it should show collection
status rather than inventing a score or report.

## Score and Writer Boundaries

- The score formula is not changed by this design.
- A complete snapshot recalculates the existing deterministic score at read
  time, allowing score-version updates without a new history crawl.
- The writer receives a complete factual snapshot only. It must treat
  `recent_prs` as a recent sample and use durable aggregate fields for claims
  about all-time PR and impact totals.
- Self-closed PRs remain classified by the existing scoring rules; the durable
  collector preserves the raw state and does not add an automatic penalty.

## Deferred Work

These are intentionally not part of the current implementation:

1. Completed-snapshot delta refresh using durable watermarks and overlap
   windows. Until that exists, a collection-version change or explicit
   collection policy is the only reason to crawl history again; Redis TTL is
   never a reason.
2. Operator dashboards for queue depth, phase duration, GitHub quota use, and
   failed-run diagnostics.
3. Retention/compaction policy for high-volume raw commit-discovery rows after
   their verified per-repository aggregate has been retained.
4. A self-hosted always-on worker alternative for deployments that cannot use a
   sub-daily Vercel Cron schedule.

## Acceptance Checks

- A normal Redis miss with a complete Turso snapshot performs no GitHub crawl.
- A 300+ merged-PR account returns `collecting_public_history` instead of
  failing in the bounded aggregate query.
- Restarting the server between phases resumes from the persisted cursor.
- Concurrent API and Cron drains never run two collection steps at once.
- A contribution-graph resource limit reaches verified commit recovery rather
  than producing zero commit-only impact as a final result.
- No final score, leaderboard fact, or writer report is generated from a
  partial run.
- `CRON_SECRET` is accepted only by the internal worker route; no credential is
  exposed to the browser or CLI.
