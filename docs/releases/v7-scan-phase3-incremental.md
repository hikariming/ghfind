# Collection v7: optional incremental scan cursors

Score stays v18. Collection stays v7. Cursor rows live beside the public
snapshot and do not change its JSON, coverage values, or `source_status`
object. `GHFIND_DISCOVER_SCORE_V1` is untouched.

## Flag

`GHFIND_SCAN_INCREMENTAL_ENABLED` defaults off. Accepted on values are `1`,
`true`, and `on`. With the flag off, the worker is the current dev path:
in-process Collect, then fullscan when coverage is `partial_public`, and the
existing `GHFIND_SCAN_FANOUT_ENABLED` semantics.

Rollback is unsetting the flag. Do not bump collection or score, and do not
rewrite stored snapshots.

## When the flag is on

Inventory is the resumable source. Its watermark is the newest `pushedAt`.
The next scan stops once a page is older than that timestamp. Items that
share the timestamp are kept and deduped by repository id, so two pushes in
the same second are not dropped. GraphQL `endCursor` is not a resume token.

Merged and external PR connections are ordered by created time, not
`mergedAt`. Those sources still read their existing window on every scan.
Commit years and workflow landings also stay on their existing full pull.
A fan-out repos part may carry the `pushedAt` watermark. Other parts do not.

Cursors are written only after the public scan row commits. The pending
book stays on the call that collected the scan, so concurrent parent and
assemble jobs cannot share it. A compare-and-swap conflict reloads the row
once and writes again. A second failure is logged and does not fail the
scan. A cursor book whose schema version is not the current one is treated
as missing.

Fan-out publishes the dependents part after the last independent part
finishes, whenever `GHFIND_SCAN_FANOUT_ENABLED` is on. The claim is
`claimed` until Publish succeeds, then `published`. A failed Publish
deletes the claim and redelivers. A claim older than one scan processing
timeout can be taken again. A published row is not published again. Two
parts finishing together still publish once. Assemble and dependents stay
idempotent by parent id.

If the merged quick scan is still `partial_public`, the worker discards
that run's incremental cursor and runs the existing fullscan deepen. The
cursor then records the full inventory page only. PR watermarks are not
marked full unless that source's complete window was stored.

## Reconciliation

The next pull of a source is a full read when any of these hold:

- the cursor book schema is not the current cursor schema, the cursor is missing, or its watermark does not parse
- `collection` on the cursor is not the current collection version
- incremental runs since the last full read reach `StatusTTL / roastFreshness`
  (7 days / 24 hours)
- the last full read is at least `StatusTTL` old (7 days)

Those thresholds are the existing job-status TTL and the #580 24h rescan
cooldown. Deletes, renames, visibility changes, and force-push drift are
corrected on that full read. An incremental pull does not delete rows.

The cursor table `scan_source_cursors` is created on first use
(`CREATE TABLE IF NOT EXISTS`). It does not alter `public_scan_runs`.

The live scan path is the TypeScript Worker (`src/lib/scan-core.ts`,
`src/lib/github.ts`). It reads `GHFIND_SCAN_INCREMENTAL_ENABLED` with the
same `1` / `true` / `on` values. Inventory resumes on `pushedAt` and dedupes
a shared second by repository id. Pull requests, commit years, and workflow
landings stay full pulls. The cursor is written only after
`publishCompleteQuickScan` commits. A `partial_public` quick scan drops that
run's book; the existing deepen records the full inventory page.
Reconciliation uses the same 7-day status TTL and 24-hour freshness window.
`rl:scan` and the 100/hour auto-rescan cap are unchanged. The Go ScanWorker
is not what production runs.

## Validation

Go tests use a fictional upstream only. They check that an incremental merge
matches a full scan of the same add, update, and delete, that a missing or
wrong-version cursor reconciles, and that the flag off does not publish a
`since` watermark.
