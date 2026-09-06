# v10 / v10 / v4 risk-scoring release

## Change

The six positive dimensions and `base_score` are unchanged. The public risk
layer is now v10: footprint scarcity produces notes only, while active
manipulation requires sufficient bounded evidence and is capped at 25 points.
The hidden `spamBotScore` remains independent.

## Rollout

1. Deploy with score and roast cache versions `v10` and collection version `v4`.
2. Run the v10 canonical backfill from complete v4 snapshots in resumable
   pages of 100. Public reads must contain only v10 rows during the backfill.
3. Verify that six-dimensional/base values are unchanged, footprint-only
   accounts have `total_penalty = 0`, and every non-zero penalty is reproducible
   from `risk_assessment.signals`.
4. Confirm roast keys include `v10:v10:v4`; a v9 score/roast is never reused.

## Rollback

Revert the application release as one score/risk change: restore the prior
scoring implementation and `SCORE_CACHE_VERSION` to `v9`, then redeploy. Do not
make v9 public reads coexist with v10 in the same ranking query. Existing v10
rows are retained as migration data and the rollback is recoverable by a later
v10 redeploy/backfill.
