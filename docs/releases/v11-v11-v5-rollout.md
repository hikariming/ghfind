# v11 / v11 / v5 evidence-backed newcomer maturity bonus

## Isolated change

Only the score version advances: previous Node tuple v10/v11/v5 becomes
v11/v11/v5. All tier thresholds and six dimension maxima remain unchanged.
Risk remains v10 and report wording remains roast v11. The standalone Go scorer
advances score to v11 while retaining its existing collection version v4; this
release does not normalize unrelated collection-version differences.

See [the scoring rule](../scoring/super-newcomer.md) for the 0..4 maturity bonus,
evidence requirements, and 3-year finite decay. No new metric or API field,
persistent growth state, LLM calibration, or database schema migration is needed.

## Rollout

1. Run scoring and release-contract tests across TS, Go, and Python. Compare
   changes by age and evidence quality in representative data before production;
   synthetic fixtures validate behavior but do not establish population fairness.
2. Deploy scorer code, Node and Go score-cache constants, the release manifest,
   and rebuilt local SDKs together. Normal reads must require score v11; a v10
   cached score or report must not be relabeled v11 without recomputation.
   Roast version stays v11, but its cache key includes the score version, so
   stale score-v10 reports will not satisfy new requests.
3. For existing archived scans, use the authenticated, bounded backfill described
   in [canonical-score-backfill](../operations/canonical-score-backfill.md).
   Keep BACKFILL_SCORES_APPLY_ENABLED disabled; inspect dry-run results first.
   Enable apply only for a supervised rollout and keep the emergency pause switch
   available. Never trigger a bulk scan or LLM job just to migrate score versions.
4. Re-scoring snapshots recomputes the formula using recorded facts and recorded
   account age. It is not fresh GitHub collection. Refresh age and activity with
   fresh scans when current scores are needed; do not change a pure scorer's
   output merely because the system date advanced.
5. Verify current score reads, ranking/score materialization, new cache keys,
   stale score rejection, and a regenerated report. Older accounts and
   non-qualifying newcomers should keep identical deterministic scores; qualifying
   accounts should change by no more than 4 points.
6. Historical emergency reads may use the immediately previous v10/v11/v5 tuple
   through the existing explicitly marked path. Do not include it in normal
   public score-read or roast-replay compatibility lists.

## Rollback

Revert scorer code, both runtime score constants, and the release manifest as a
single deployment back to the prior tuple. Retain v11 artifacts in their versioned
namespaces; do not rewrite them as v10 or delete archival evidence. If supervised
backfill has already materialized v11 scores, restore/recompute prior-version
materializations from snapshots through the existing controlled workflow before
relying on prior-version rankings. Do not roll back only the constant and leave
the new formula producing mislabeled scores.
