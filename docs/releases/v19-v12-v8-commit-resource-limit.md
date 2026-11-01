# Collection v8: subdivide resource-limited commit years

Only collection advances (v7 → v8). Score stays at v19 (smooth impact /
contributionEvidenceCeiling soft forms). Roast v12 and discover scoring remain
unchanged. Prior v7/v6/v5 artifacts retain their original hashes and remain
readable; none is relabeled complete under v8.

Score formula and goldens are the v19 contract in
`docs/releases/v19-v12-v7-smooth-impact.md`. This document covers the collection
contract only. The merged manifest records previousRelease as score v19 /
collection v7 and targetRelease as score v19 / collection v8, so the version
gate sees a single collection-component change.

## Why collection must bump

Cached public scan snapshots keyed by
`scan:${SCORE}:${COLLECTION}:${username}` and the durable
`score_source_collection_version` column must invalidate when commit attribution
changes. Without a collection bump, warm v7 rows that recorded
`impact_commit_count = 0` with `aggregation_unavailable = false` after skipping a
pathological year would keep serving the under-count until a manual rescan.
Score and roast stay put because the formula is unchanged; only the inputs
collected from GitHub improve.

## Root cause (v7 regression)

Introduced in #582 (`044f8a2e`, collection v7). When a multi-year
`commitContributionsByRepository` batch hit `RESOURCE_LIMITS_EXCEEDED`, the
collector re-ran one year per query and **skipped** any single year that still
failed, noting `commit_resource_limit`. `fetchCompleteCommitWindow` already
subdivided **saturated** (≥100 repo) windows after a successful year response,
but a year that failed the full-year query never reached that path. Hyperactive
accounts therefore persisted empty `impact_repos` / `impact_commit_count = 0`
with `aggregation_unavailable = false` (the empty successful merge looked
complete). Older commit-only mega-repo rows that lived only in the dropped year
disappeared from impact.

Python's simplified `_fetch_contrib_repos_by_year` has no quick/full scope and
no resource-limit skip path; live production collection is the TypeScript Worker
(`buildScanResult` → `collect` → `fetchCommitContribReposByYear`). Go mirrors the
Node collector and had the same skip.

## Fix

In full mode, a single-year `GitHubResourceLimitError` /
`ErrGitHubResourceLimit` now falls through to `fetchCompleteCommitWindow` for
that year (same disjoint half-window recursion used for saturation). Quick mode
still notes `commit_resource_limit` and leaves the year empty so the existing
partial → background fullscan escalation recovers it. Years already recovered
via the complete-window path are not re-split when the merged child count
exceeds 100 repositories.

Synthetic fixtures use only `fiction-*` logins and `fiction-org/*` repos. No
real usernames appear in code, tests, commits, or this plan.

## Validation and rollback

Run TS/Go unit suites (including the new resource-limit subdivision cases),
scoring goldens, TypeScript checks, lint, and `versions:check` against
origin/main. Tests use synthetic upstream HTTP responses. Local live validation
against real accounts is operator-side only and is not part of CI.

Review only, no merge/deploy in this task. If rollback is needed, revert this PR
as a unit to collection v7 and its prior release manifest. Do not rewrite v8
snapshots or bulk rescore. Full-mode subdivision adds GraphQL calls only for
years that already hit resource limits; quiet accounts are unchanged. Extreme
accounts remain bounded by the existing background wall-clock budget.
