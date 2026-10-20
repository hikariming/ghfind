# v14 / v12 / v6: continuous attributed creator impact

Score v13 → v14; roast v12 and collection v6 unchanged. The inputs and GitHub
queries are unchanged; deterministic derived impact changes, hence a score
version. Go writes v14 and reads v14/v13, matching Node. Existing v13/v6
artifacts remain readable until organic refresh. No aliasing or bulk rewrite.
Scan cache and single-flight keys include score + collection because old raw
metrics already contain derived impact, which score(metrics) cannot reconstruct.
Old cached bytes and database snapshots are retained, never relabeled v14.

For nonnegative outside human merged PR count P and forks F:
- w = 1 − exp(−1.5 ln(1+P) − 0.6 ln(1+F)). PRs are stronger evidence than
  forks: one PR yields .646, two forks .483, ten forks .763. Marginal evidence
  returns diminish; zero evidence gives exactly zero.
- creator = .85 first commit only, .70 release only, 1 both, 0 membership only.
- suspicion s = stars/(stars+100) / ((1+F)^2 (1+P)^2). It measures star mass
  unsupported by outside adoption, continuously, per repo. Discount exp(−7s)
  suppresses unsupported high-star repos to about .001. Explicit severity
  is clamped to [0,1]; legacy boolean-only suspect inputs use s=.9. Fresh
  collection always supplies numeric severity, including missing community
  measurements, so the old boolean cannot introduce a cliff.
- impact = baseline + w·creator·discount·max(0, legacy − baseline), separately
  for prestige and depth. Existing work/doc/code/tenure weights are retained.
- Own star-depth ramp = 1 − exp(−ln(1+stars/100)): .833 at 500, .909 at 1000.
  This damped depth also needs w and discount; empty orgs cannot earn ecology
  from stars alone. Own repos no longer have the 200/1000 star admission cliff.
  External repo admission, resource exclusions and identity attribution remain.
- Community facts are discounted continuously rather than cleared by the old
  account-wide boolean. The account-level authenticity penalty is unchanged.

Synthetic fixtures explicitly vary old boundaries, evidence, creator signals,
severity, missing facts and personal ownership. Historical Oct18 raw metrics
are preserved. Regression fixture derived metrics are recomputed for v14;
prior derived metrics are retained separately for audit.

Release through PR → green CI → authorized admin merge → CI deployment. Force
rescan only yifanxuaaa; verify total/ecosystem and v14 provenance. No deletion,
index rebuild, bulk rescan, or production configuration changes. Roll back the
code and manifest and redeploy if verification fails; retain all stored data.

Historical regression: alchaincyf 54.6 → 59.9 because the collector now forwards
already-fetched personal-repo fork counts and removes the own 1000-star cliff.
The observed star-repo inputs are retained; other sampled users move by at most
0.4. Oct18 yifan replay: #505 76.3 / 8.1 → v14 76.2 / 8.0.

## Public-read compatibility correction

Production canary octocat still has a verified v10/v5 snapshot. A two-entry
v14/v13 read order hid it and caused the production profile smoke to return
404. Preserve the full v14 → v13 → v10 read chain and collection v6 → v5.
The retained history is pinned to the actual pre-v14 main commit 65c99256;
versions:check verifies its exact manifest and ancestry. Unknown v9 labels
remain forbidden, v11/v12 stay retired. Canonical writes remain v14/v6;
v10/v5 is hashed stale read-only history and cannot become a canonical scan.
No score formula or version changes in this follow-up; no bulk rescan/backfill.
Go public read SQL includes v10 as well. Python has no server read registry.
