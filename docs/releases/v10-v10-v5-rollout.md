# v10 / v10 / v5 first-commit original attribution

## Change

Scoring and roast formulas are unchanged. Collection v5 lets a long-term
organization repository count as an attributed original when the scored user
authored the default-branch first commit, even without public org membership.
First-commit identity never replaces the long-term maintenance gate. Public
members still skip the first-commit lookup.

The same collection also always aggregates the newest 300 native merged PRs
for `impact_pr_count`. Histories larger than that stay
`merged_pr_contribution_aggregation_incomplete` so durable scan can replace
the lower bound. The previous quick collector published `0` instead.

## Rollout

1. Deploy with score and roast cache versions `v10` and collection version `v5`.
2. Run the v5 collector backfill from complete v4 snapshots in resumable
   pages of 100. Public reads must contain only v5 collection rows during the
   backfill.
3. Verify that membership-attributed originals stay attributed, that a first
   commit by the scored user can add a previously missing org repo, and that a
   first commit by someone else does not.
4. Confirm roast keys include `v10:v10:v5`. Emergency reads may still use the
   previous `v10/v10/v4` tuple.

## Rollback

Revert the application release as one collection change: restore the prior
collector and `PUBLIC_SCAN_COLLECTION_VERSION` to `v4`, then redeploy. Do not
make v4 public collection reads coexist with v5 in the same ranking query.
Existing v5 rows are retained as migration data and the rollback is recoverable
by a later v5 redeploy/backfill.
