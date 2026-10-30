# Score v17 rollout

Only score advances. Roast v12 and collection v6 stay unchanged. Public reads
fall back through v17 → v16 → v15 → v14 → v13 → v10; prior snapshots keep provenance.

## What changes

Co-built / organization project attribution (`coCreatorShare`) no longer relies
on lifetime commit share alone. The role is the strongest of three continuous
signals:

- **Lifetime dominance** — commit share, rank against the leading human
  committer and merged-PR share (unchanged formula).
- **Current maintenance** — default-branch commits and merged PRs in the last
  180 days plus PRs reviewed for others. A dominant current maintainer earns lead
  credit even with a low lifetime share.
- **Content weight** — sampled core churn relative to repository size, so a few
  large core feature PRs earn bounded major credit.

Content churn excludes lockfiles/config (by extension), vendored, generated and
build-output paths, presentation paths, and caps each file at 1,500 lines.
Balanced add/delete rewrites (mass formatting, renames, moves) keep 10% weight
and never make a sample substantive.

Contributor totals exclude bots from both the denominator and the leader. The
contributor list is paged (up to 300 rows) until the user appears; truncated
lists fall back to the default-branch history total and the user's own graph
commit count. Identity/tenure/confidence are bounded modifiers instead of
multiplicative cliffs; small shares fade smoothly (`share · smoothstep(share/0.15)`)
so incidental PRs into very large repositories stay ecosystem impact. The
star-farm discount is `exp(−5·severity)`.

`top_starred_original_repo_quality_score` is no longer multiplied by the
attribution share: stars are already share-weighted, so the product
double-counted attribution and made co-maintained products read as weak
profile/config repositories.

Roast payloads round star counts to integers, add factual guardrails for led /
co-maintained projects (commit, rank, merged-PR and recent-maintenance facts) and
suppress the weak-top-project note for them. No roast version bump: cached roast
keys already include the score version.

## Calibration evidence

Offline replay (`scripts/research/v17-attribution-replay.mts`) over the frozen
223-record v16 paired-collector set, 141 with attributed repositories. The
replay recomputes shares from stored facts; recent-maintenance and review facts
are absent there, so that signal is neutral offline and only adds credit live.
Replay pipeline noise versus stored v16 scores is ≤0.2.

- Median delta **0.0**; median |delta| **0.0**.
- 168 unchanged, 41 up, 14 down (largest decrease −0.6).
- All 82 accounts without attributed repositories are unchanged.
- 14 accounts move ≥2.5, all upward (+3.1 … +11.6). Each was reviewed: half
  are real co-maintainers of product repositories whose share rose, half had
  their own personal star points restored after the double-count fix (an
  incidental tiny-share repository previously zeroed all star points).

Identity-bearing replay inputs stay outside git and are passed via
`V17_SAMPLE_DIR`; output carries salted anonymous IDs only.

## Rollback

Revert the v17 code and release manifest together through the normal CI-gated
production workflow. Retain all v17 and earlier stored artifacts: do not delete,
relabel or backfill them. No backfill, data deletion or collection migration is
part of this release.
