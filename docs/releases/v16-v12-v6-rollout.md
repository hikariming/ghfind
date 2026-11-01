# Score v16 rollout

Only score advances. Roast v12 and collection v6 stay unchanged. Public reads
fall back through v16 → v15 → v14 → v13 → v10; prior snapshots keep provenance.

Original stars use liveness × continuous content evidence. Non-code byte share
combines with naming/topic evidence; code bytes suppress naming evidence.
Missing language data is neutral. One root-directory listing per hydrated original supplies optional layout evidence;
no recursive trees are fetched. Missing layout evidence is neutral.
The 0.25 kind floor combines multiplicatively with existing engagement evidence.
Star points also receive a confidence-weighted smooth concentration discount;
independent project substance remains unchanged. Personal originals use the same
formula, and original content evidence also discounts ecosystem star credit.

Validate shared TS/Go/Python fixtures and at least 200 paired offline samples.
Median absolute drift must be ≤1 and engineering controls within ±1.5.
Review and tighten any unexpected |delta| ≥2.5; the declared content-pattern
calibration band is 46–50.
Publish through green PR CI, admin merge, then the canonical production workflow.
Live sample identities must be supplied through environment variables. Never
commit sample handles, numeric user IDs or raw production snapshots. No backfill,
data deletion, identity relaxation or collection migration is part of this release.

## Calibration evidence

The full collector replay used 223 complete v15/v16 pairs from a fixed 232-row
private evidence set. Nine rows lacked frozen HTTP facts and were excluded;
partial results never enter the gate. Optional missing root listings remain
neutral. Existing snapshots were supplemented with 1,287 bounded root listings;
no production data was updated.

Median delta: **0.0**. The content-pattern sample moves **62.3 → 49.6**;
its original-project subscore moves **12.0 → 7.9**, retaining substance.
Four manually reviewed engineering controls move **−0.9, −1.1, −0.2, −0.1**.
No other paired sample has |delta| ≥2.5; no sample increases.

Review found and corrected a backend/frontend application false positive and
flat-source layouts. Independently established external maintenance reduces the
account concentration discount continuously. The account discount is bounded by
star mass (`stars / (stars + 5000)`) so small projects are not treated like large
star portfolios. The same concentration evidence discounts only the own-project
fraction of ecosystem credit; external work retains its existing v15 treatment.

Reproduce with `scripts/research/v16-full-replay.mts` and
`scripts/research/v16-distribution.mts`. Input/cache directories and the pattern
and control accounts are environment variables. Use `V16_PAIRED=1` for release
gates; metric-only exploration cannot pass the release gate.

## Rollback

Revert the v16 code and release manifest together through the normal CI-gated
production workflow. Retain all v16 and earlier stored artifacts: do not delete,
relabel or backfill them. The previous v15 code/manifest restores its canonical
write tuple and read chain; verify the exact deployed commit before live checks.
