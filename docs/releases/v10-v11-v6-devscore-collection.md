# v10 / v11 / v6 devscore collection (background)

## Change

Collection v6 runs devscore's resumable collector (contract v15) as a
background job (`devscore_jobs`) next to ghfind's bounded `collect()`. Every
published snapshot carries the devscore summary (`ScanResult.devscore`: v3
score/tier/flags, curve and per-repo engine factors). The published score is
unchanged: score v10 (`score()` over the display metrics). Because collection
now takes minutes for large accounts, first-time lookups return `202` +
`Location: /api/scan/status/<login>`; polls advance the job until the score is
published. Score v11 (derived from the devscore summary) is the next release
and is not part of this one. Roast v11 is unchanged.

The collector (`lib/devscore/collect`) fetches only what can change the
engine's result (run blobs are temporary; only the summary is stored):

- `ext_prs` is listed in one pass without closers or reviewers. `closed_by` is
  read (from the `rejected` scan, the rest by node id) only when the list has
  ≥ slop `rej_min` CLOSED PRs (`slopNeedsClosers`); `reviewers` only for MERGED
  PRs of repos rule H1 can apply to (`unreviewedCandidate`). Elsewhere both are
  null.
- `star_history` only for candidates whose F4 spike can decide rule F
  (`hypeNeedsStarHistory`).
- Never-scored fields are not collected: repo `archived`, `created_at`,
  `primary_language`, `issues_total`, `prs_total`, `review_depth`,
  `dependent_repos`; ext PR `closed_at`, `merged_at`, `association`; developer
  `account_created_at`, `restricted_by_year` (the engine reads them as null).

The predicates live in the engine next to the rules they mirror;
`engine/__tests__/collect-gates.test.ts` proves the gated input rates
identically on every fixture.

## Rollout

1. Create the R2 buckets `ghfind-devscore-cache` (production) and
   `ghfind-devscore-cache-dev` (dev, preview, local), each with a 30-day
   lifecycle delete rule.
2. Apply D1 migration `0016_devscore_jobs.sql`
   (`wrangler d1 migrations apply ghfind --remote --env <env>`).
3. Deploy with score `v10`, roast `v11`, collection `v6`. Public reads require
   v6 provenance; v10/v11/v5 rows are the read-only emergency fallback.
4. Drive recovery and backfill with the CRON_SECRET route:
   `POST /api/internal/devscore/advance` `{"jobs": 3}` every minute, and
   `{"backfill": N}` to queue accounts still on v10/v5 (highest score, then most
   recently looked up; never more than 50 active jobs).
5. Verify: a new account goes 202 → polls → published v10/v6 score carrying a
   devscore summary; `GET /api/score/<login>` then returns `source: "indexed"`.

## Rollback

Revert the application release as one collection change: restore collection
`v5` and the synchronous scan path, then redeploy. v6 rows and `devscore_jobs`
are retained; a later v6 redeploy/backfill recovers them.
