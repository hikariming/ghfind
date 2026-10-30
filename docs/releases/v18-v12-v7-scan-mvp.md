# Collection v7: fork filtering and automatic fullscan

Only collection advances (v6 → v7). Score stays at v18 (contrib-quality from
dev / #581; public reads remain v18→v17→v16→v15→v14→v13→v10). Roast v12 and
GHFIND_DISCOVER_SCORE_V1 remain unchanged. Go's stale v5 write constant is
aligned with v7. Prior v6/v5 artifacts retain their original hashes and remain
readable; none is relabeled complete under v7.

Score formula and goldens are the v18 contract in
`docs/releases/v18-v12-v6-rollout.md`. This document covers the collection
contract only. The merged manifest records previousRelease as score v18 /
collection v6 (dev's target) and targetRelease as score v18 / collection v7,
so the version gate sees a single collection-component change.

## Inventory and score neutrality

GitHub GraphQL inventories public OWNER repositories with `isFork:false`.
REST `type=owner` alone includes forks and cannot exclude them server-side.
A separate cheap `isFork:true` totalCount preserves `fork_repo_count`, and
`fetched_repo_count` includes that inventory count. Unworked forks never hydrate
or enter impact. Existing verified contribution/organization attribution gates
remain unchanged. Inventory mapping preserves REST open_issues_count semantics
(open issues plus open PRs). Collection changes score inputs, not the scoring formula.

Synthetic fixture `scan-mvp-fiction.json` compares fiction-highfork (500 forks)
with fiction-lowfork (0 forks), each with the same two nonempty originals and
80 total stars. Both implementations assert high score ≤ low score and retain
the mostly_forks footprint note. Existing score goldens are unchanged.

## Escalation and honest coverage

The existing quick limits are named constants, shared with detection:

- Original inventory: `quickRepoPages` / `QUICK_REPO_PAGES` = 2, GitHub page = 100.
  hasNextPage after those pages, or total public repositories above 2 × 100,
  requests full collection. The latter also detects fork-heavy inventories.
- External merged PRs: `externalMergedPRCap` / `EXTERNAL_MERGED_PR_CAP` = 300;
  touching the cap requests full collection.
- Native merged history: `mergedPRWindow` / `MERGED_PR_WINDOW` = 300;
  an overview total beyond the window or resource-limit degradation escalates.
- Commits: existing 6-year and 100-repository-per-window bounds, skipped years,
  and unavailable aggregation escalate. Full reads all years and splits saturated
  repository windows into disjoint date ranges, discarding truncated parents.
- Workflow landings: existing 100 closed candidates and 25 verification ids;
  saturation or unavailable evidence escalates. Full pages closed history and
  verifies batches of 25 with the unchanged same-bot label/close proof.

Full uses the native merged connection rather than GitHub Search, avoiding its
1000-result ceiling. Presentation and quality samples retain their established
bounds. `collection` records mode, coverage, and truncation reasons. Persistence,
scan/score/MCP APIs report `partial_public` or `complete_public` from evidence;
old snapshots with no coverage metadata retain `quick`, old collections `legacy`.
A failed/unavailable optional source remains partial, never falsely complete.

## Background and #580 overlap

No new queue or lock namespace. ScanSlot continuation and Go's Rabbit worker
own quick → full within the same per-user flight. The interactive ScanSlot wait
stays 45s and returns 202 when work continues. The five-minute background budget
is shared across quick and full. Go independent sources use errgroup with two
concurrent source jobs before dependent hydration/impact/community work.

Inline quick producers schedule full via #580's scan-background-refresh helper,
its NX refresh admission, and coalesceScan producer lock. Visit refresh and full
requests share that admission. With ScanSlot, that helper arms the same durable
alarm and returns immediately, retaining the existing background lease. Redis-only
deployments keep #580's inline background fallback and its runtime lifetime limits.
Background refresh now forces past the warm cache;
any truncated refresh deepens itself, so an existing refresh owner subsumes a
concurrent full request. Pending refresh metadata prevents a warm baseline from
being mistaken for the new owner's completed result. #580's 24h manual cooldown, visit admission and budget
are unchanged. Failure cooldown/lease recovery remain in the existing machinery.

## Validation and rollback

Run TS/Go unit suites, scoring goldens, race tests for collector/worker,
TypeScript checks, lint, version transition check against origin/dev and the
existing CI. Tests use synthetic upstream HTTP responses and local fixture DBs.
No real account scans, production writes, backfills, cron or secrets changes.

Review only, no merge/deploy in this task. For a later rollout, deploy the
additive coord pending contract before the v7 API collector. If rollback is needed,
revert this PR as a unit to collection v6 and its prior release manifest. Do not
rewrite v7 snapshots or bulk rescore. v7 cold caches and larger histories increase
GitHub requests; rate/resource failures preserve partial coverage and existing
retry/lease behavior. Fullscan is bounded by the existing background wall-clock
budget, so extreme accounts can still fail or remain partial and require retry.
