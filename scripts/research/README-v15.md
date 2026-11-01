# v15 read-only paired replay

The account sample is taken from production D1 using SELECT only: the newest
snapshot per username from `public_scan_runs`, at most 500 rows; select the first
200 by recency, add the 50 highest historical external-documentation ratios,
and ensure lofisu, yifanxuaaa, samzong, hikariming, asperformias and asukaminato0721. Deduplicate case-insensitively.
The resulting cohort has 232 accounts. No score result is used in selection.

Historical snapshots lack per-file additions/deletions. The initial frozen-impact
replay is exploratory only. The release gate uses `v15-full-replay.mts`: both
complete collectors run on the same cached, read-only GitHub responses, with a
fixed clock and the v14 source pinned to commit 2010358b. Complete collector
execution does not imply exhaustive GitHub history; existing collection caps
are disclosed in the report. No production database writes or scan jobs occur.

Input is a JSON array of D1 rows with `username`, `metrics` (serialized JSON),
and the recorded snapshot fields. Keep raw responses outside the repository.
Authentication uses the local `gh` account and the installed Wrangler HTTP
runtime with pooled proxy connections; credentials are never logged or
written to the response cache. The adapter rejects non-GitHub requests and any
operation other than GET or GraphQL query. It caches successful responses and
404 facts; quota errors and transient GraphQL errors must be retried, not cached.

```sh
V15_SAMPLE_PATH=/tmp/v15-sample.json \
V15_REPLAY_DIR=/tmp/v15-full-replay \
pnpm exec tsx scripts/research/v15-full-replay.mts
pnpm exec tsx scripts/research/v15-distribution.mts \
  /tmp/v15-full-replay /tmp/v15-final-distribution.json
```

Three account workers share four HTTP slots. Each execution has a bounded
request budget (default 4500); respect the GitHub quota and resume after reset
when necessary. Completed records carry the candidate's collector/presentation/co-creator/
scorer hash and are reused only for the same code. A cached rerun can use
`V15_REPLAY_ONLY_EXISTING=1`; `V15_MAX_REQUESTS` reduces the request budget.
The report rejects stale candidate records and exits nonzero unless sample,
named-user, lofisu, protected-control and median gates all pass. The largest
20 declines and 20 increases still require manual review, including core work and repository
context and unsupported-star/trivial-work evidence; automatic numeric gates alone do not authorize release.

Release records must have `rate_guarded: true`: a rate-limit response invalidates
every in-flight paired result, even when a best-effort evidence helper would
otherwise return neutral data. Quota/request-budget exhaustion also rejects all
in-flight rows. `V15_HTTP_SLOTS=1` serializes network reads for the final cached
replay; only validated rows with the current candidate hash enter the report.

The exact REST `/contributors` 403 saying the history/contributor list is too
large is a stable unavailable-evidence response, not a quota event. It may be
cached like a 404; it supplies no positive contributor-rank evidence. Other 403s
and all 429s trigger the rate guard and honor cooldowns.
