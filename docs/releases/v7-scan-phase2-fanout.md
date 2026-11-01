# Collection v7: optional scan fan-out

Score stays v17. Collection stays v7. This change is worker orchestration
only: the public snapshot, coverage, and `source_status` object shape are
the same contract collection v7 already writes. `GHFIND_DISCOVER_SCORE_V1`
is untouched.

## Flag

`GHFIND_SCAN_FANOUT_ENABLED` defaults off. Accepted on values are `1`,
`true`, and `on`. With the flag off, the Go worker keeps the in-process
Collect path (errgroup, then fullscan when coverage is `partial_public`).

Rollback is unsetting the flag. Do not bump collection or score, and do not
rewrite stored snapshots.

## When the flag is on

After GetUser and the contribution overview, cheap totals decide the plan.
Thresholds are the existing collection constants (`quickRepoPages` 2,
page size 100, `mergedPRWindow` 300, `externalMergedPRCap` 300). A light
account stays in process. A heavy account enqueues at most four part jobs
on `scan.part.v1`. Search-backed external PRs share lane 0. Parts that do
not fit the cap run once inside assemble, so the stitched result matches
an in-process collect of the same inputs.

The parent row waits until every enqueued part has a payload, then publishes
`scan.assemble.v1`. Assemble scores and persists with the existing coverage
rules. A failed part is stored as that source's `failed` or `unavailable`
state; other sources stay `complete` or `pending` from their own truncation
reasons. Repeating `(username, parent id, part)` keeps the first payload.

Part tables (`scan_part_parents`, `scan_part_runs`) are created on first use
in the existing Turso database. They do not alter `public_scan_runs` columns
or historical rows.

## Validation

Go tests use a fictional upstream only. They check that a split assemble
matches the in-process score and coverage, that a failed repos part yields
`partial_public` with `original_repos=failed`, that a repeated part does not
overwrite the first payload, and that a light account publishes no parts.
