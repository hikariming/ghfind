# v11 / v11 / v6 devscore score

## Change

Score v11 is devscore's v3 score, derived from the devscore summary every
collection-v6 snapshot already carries (released in v10/v11/v6). The six
ghfind dimensions become display values derived from devscore factors and no
longer feed the final score; RawMetrics stay display/roast evidence only.
Collection is unchanged (v6), so existing v6 snapshots are rescored without
re-collecting. Roast semantics are unchanged (v11).

## Rollout

Prerequisite: v10/v11/v6 is deployed (R2 buckets, migration 0016, advance cron).

1. Deploy with score `v11`, roast `v11`, collection `v6`. Public reads serve
   only v11 rows; v10/v11/v6 rows are the read-only emergency fallback.
2. Re-materialize v6 snapshots as v11 without GitHub calls (the snapshot's
   devscore summary is the whole input); accounts without a v6 snapshot are
   queued with `POST /api/internal/devscore/advance {"backfill": N}`.
3. Verify that `GET /api/score/<login>` returns the devscore v3 score and tier
   with v11 provenance, and that the profile breakdown shows base − final.

## Rollback

Revert the application release as one score change: restore score `v10`,
then redeploy. v6 snapshots still carry both the metrics and the devscore
summary, so v10 is re-materialized from them without re-collecting.
