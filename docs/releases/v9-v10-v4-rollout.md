# v9 / v10 / v4 roast release

## Change

GitHub REST's `open_issues_count` combines open Issues and pull requests. The
writer now receives only a bounded GraphQL `open_issue_count`, which excludes
pull requests, and is explicitly prohibited from suggesting Issue cleanup when
that count is absent or zero.

## Rollout

1. Deploy with roast cache version `v10`.
2. Confirm `/api/score/4evour` remains a canonical v9/v4 score and a new roast
   does not replay the previous v9 report.
3. Re-roast `4evour`; `Tour-Pass` must not receive Issue-cleanup advice when
   its verified open-Issue count is zero.

## Rollback

Revert this release as one roast-version change: restore `ROAST_CACHE_VERSION`
and the release manifest target to `v9`, then redeploy. Do not create aliases
between v9 and v10 report artifacts.
