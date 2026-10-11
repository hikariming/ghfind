# v10 / v11 / v6 transferred original attribution

## Change

Scoring and roast formulas are unchanged. Collection v6 treats an external
pinned repository as a discovery candidate, then verifies a transfer by
requesting the scored user's former `owner/name` REST path without following
redirects. The repository is attributed only when GitHub returns a permanent
redirect whose stable numeric repository ID matches the current pinned
repository.

A pin alone is never ownership evidence. Existing public-organization and
first-commit attribution paths keep their long-term contribution gate, and
private, forked, and documentation-like repositories remain excluded.

## Rollout

1. Deploy only after the pronoun-aware roast v11 release (`v10/v11/v5`)
   is on main and verified. Keep score `v10` and roast `v11`, and advance
   only collection to `v6`.
2. Re-run the v6 collector for complete v5 accounts in resumable pages of 100.
   Public reads must contain only v6 collection rows during the refresh.
3. Verify a known transferred-and-pinned repository is included, while a
   pinned repository without a matching former-owner redirect is excluded.
4. Confirm existing organization-membership and first-commit attributions are
   unchanged and roast keys include `v10:v11:v6`.

## Rollback

Revert the application release as one collection change: restore the prior
collector and `PUBLIC_SCAN_COLLECTION_VERSION` to `v5`, retaining score
`v10` and roast `v11`, then redeploy. Do not
make v5 public collection reads coexist with v6 in the same ranking query.
Existing v6 rows are retained as migration data so a later v6 redeploy remains
recoverable.
