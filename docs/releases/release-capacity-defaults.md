# Release capacity defaults (no version bump)

Raises on-view auto-rescan / auto-reroast and per-principal rate-limit **code
defaults** ahead of the score v19 + roast generator rollout. Env vars still
override. **No** `SCORE_CACHE_VERSION` / `ROAST_CACHE_VERSION` / manifest change.

## Defaults

| Gate | Old | New |
| --- | --- | --- |
| `GHFIND_AUTO_RESCAN_MAX_PER_HOUR` | 20 | **100** |
| `GHFIND_AUTO_REROAST_MAX_PER_HOUR` | 20 | **60** |
| auto-reroast `maxJobs` / tick | 3 | **5** (`maxRuntimeMs` still 8min; per-login single-flight unchanged) |
| `rl:roast:m` | 8/min | **12/min** |
| `rl:roast:d` | 60/day | **100/day** |
| `rl:scan` | 10/min | **15/min** |

Unchanged: `SCAN_COLD_CONCURRENCY`, leases, discover, incremental, fanout, reconcile.

## Why capacity without a roast cache bump

`versions:check --base-ref` forbids multi-component formal releases
(`releaseTransitionErrors`: at most one of score / roast / collection per PR).
A `dev → main` PR compares the tip manifest to `origin/main`, so landing both
score v19 and roast v13 on `dev` before the release PR would fail the same gate.

Score v19 alone is enough for new copy on view: writing a new `score_version`
clears `roast` / `roast_version` (`src/lib/db.ts` upsert), ProfileView treats
null roast as `report-pending`, and `AutoReroast` regenerates with whatever
`ROAST_GENERATOR` is set to (post-release plain var).

## Follow-up: roast cache v12 → v13

Parked on branch `grok/roast-cache-v13` (draft PR after score v19 is on
`main`). That bump is what forces stored v12 reports to refresh even when a
score rewrite did not clear them. Generator flags stay out of that PR too.
