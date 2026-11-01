# v15 / v12 / v6: concentration, smooth caps and shared project leadership

Score alone advances to v15. Public reads retain v15 → v14 → v13 → v10;
collection reads retain v6 → v5. No backfill, deletion, index rebuild or relabeling.
New optional per-file additions/deletions enrich the existing collection contract.
Old snapshots without complete file evidence stay neutral under the new discount.

Presentation P is changed-line weighted, C is top-two-repository presentation
churn share, n counts complete external PR file samples. Titles never decide the
new classification. UI library styles and non-frontend implementation languages
remain core. Asset data is not classified as presentation merely by its directory.
Site-owned frontend source and its dependency/build manifests serve presentation;
ordinary application frontend logic is not categorically discounted.

Let x=clamp((P-.4)/.4), core=max(complete nontrivial core PRs in
repositories with ≥200 stars, existing verified core PR count), and
y=clamp((core-code-churn-share-.2)/.2).
Reduction = .7*x²*(3-2*x)*(.5+.5*C)*n/(n+2)*(1-y²*(3-2*y))/(1+(max(0,core-3)/5)²).
Prestige and depth are multiplied by 1-reduction*externalMerged/merged.
External PR volume, acceptance and the core-PR bonus use 80% of that reduction; own PRs remain
neutral. The lighter contribution discount replaces the previous binary volume
penalty and cap; old impact_quality_cap remains parseable but does not constrain
new scores. Author self-closure never participates in these formulas.

Adoption evidence w=1-exp(-2.6 ln(1+P)-.6 ln(1+F)); unsupported-star severity is
stars/(stars+100)/((1+F)²(1+6P)²). Effective creator evidence is w*exp(-7*severity).
At 520 stars, one external merge produces effective creator weight .741
(prestige .403), above ten forks: weight .727 (prestige .395). Fork returns continue to saturate logarithmically. Creator
identity and all existing external repository eligibility gates remain required.

Deployment is gated on the attached read-only distribution report, all CI checks,
and admin-authorized merge. Then wait for both production workflows and force
only lofisu, yifanxuaaa, samzong, hikariming, asperformias and asukaminato0721 once each. Verify public score and persisted provenance.
Rollback restores the prior code/manifest while retaining stored public history.

## Evidence weight correction versus #507

These controlled inputs use 520 stars, both creator identity signals, identical
work facts, and no explicit inflation override. Weight includes the continuous
unsupported-star discount; prestige is the resulting aggregate prestige signal.

| Outside merged PRs | Forks | v14 effective weight | v15 effective weight | v14 prestige | v15 prestige |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| 0 | 2 | 0.2514 | 0.2514 | 0.1366 | 0.1366 |
| 0 | 10 | 0.7266 | 0.7266 | 0.3948 | 0.3948 |
| 1 | 0 | 0.1490 | 0.7408 | 0.0809 | 0.4025 |
| 1 | 2 | 0.6942 | 0.9026 | 0.3772 | 0.4904 |
| 3 | 0 | 0.6062 | 0.9571 | 0.3294 | 0.5201 |

Coefficient rationale: the 80% contribution factor replaces (rather than stacks
on) the old discrete PR-volume deduction. It includes the core-PR bonus so a
mixed PR's newly recovered core credit cannot cancel the account-level
concentration evidence. The repository code-share sample itself is now
fractional (sum of 1-presentation_share), not a second binary cutoff. Complete
nontrivial core PRs and existing verified core counts both protect maintainers.
Core-code churn adds continuous protection between 20% and 40% of the
observed external churn. This protects mixed documentation/core maintainers
even when their projects are below the ecosystem star cutoff. Generated
fingerprinted frontend bundles do not count as authored core code; ordinary
public service-worker code and business data are not classified as
presentation solely by their directories. A missing/truncated file sample
supplies no new concentration penalty. The
sample-size confidence, external share and core protection all reduce sparse
or ancillary presentation work; no account-specific exceptions are used.

The production rollout is blocked until the complete paired replay report has
at least 200 accounts, passes the named controls and median gate, and the
largest 20 declines and largest 20 increases have been manually reviewed. The preliminary frozen-impact
analysis is not sufficient to release this change.

The original #507 table's .081/.137 figures were prestige, not raw adoption
weights. Preserve its units in the comparison: one external merge now exceeds
ten forks near .40 prestige. Fork-only inputs are unchanged; the earlier
candidate that reduced the fork coefficient was rejected because it needlessly
lowered creator/maintainer scores. A 50% contribution discount would partly
undo the existing documentation-volume deduction, so the calibrated lighter
factor is 80%; external scope and core protection remain separate safeguards.


## Continuous contribution cap

Write S(x)=clamp(x,0,1)²(3−2clamp(x,0,1)). Let p be the existing
impact-prestige signal, v=S((mergedPR−40)/80), a=S((maxStars−950)/100),
h=S((p−.65)/.15), and c=S((verifiedCorePR−40)/60).
The prestige-dependent ceiling is b=20+3S((p−.3)/.5)+4h+2.5c(1−h).
The final ceiling is 27−(27−b)v(1−a).

This removes the old jumps at 80 merges, prestige .8 and 1000 own stars.
The base rises gradually from 20; strong prestige restores the full 27.
Sustained verified core work supplies up to 2.5 additional points below strong
prestige, protecting productive maintainers without making commit/PR volume
alone sufficient. These parameters apply to every account; the release report
checks the complete cohort, not just named examples. Scores retain their normal
one-decimal rounding, so displayed tenths remain discrete despite continuous inputs.

The three-point broad-prestige term releases the cap conservatively at intermediate
prestige; the four-point strong-prestige term restores it near .8. The separate
2.5-point verified-core term protects sustained implementation rather than merely
raising every high-volume account. The coefficient comparison is replayed over the
whole fixed cohort, with named controls as additional gates, never account-specific
branches.

## Original & Led Projects

Personal ownership remains full credit. Public, non-fork repositories owned by
another person or organization may supply a fractional co-creator share. Review
at most eight candidates, ranked by authored commits plus four times merged PRs.
No membership or first-commit requirement applies to co-creators.

For each candidate, commit share uses the larger of the top-100 contributor sum
and default-branch history count as denominator; rank compares the user's count
with the leading contributor. PR share uses the user's merged PRs divided by all
merged PRs. Dominance is .5√commitShare+.2rank+.3√PRShare. Identity evidence is
.35+.2role+.2releaseAuthor+.2maintainerFile+.05pinned; role is a weak signal from
OWNER/MEMBER/COLLABORATOR, not proof by itself. Work saturation is
1−exp(−ln(1+commits+3PRs)/2), tenure is .6+.4(1−exp(−activeYears/2)),
and sample confidence is n/(n+2).

Substance is (1−exp(−coreChurn/200))S(substantiveSamples/3). A sample needs more
than five implementation lines; only complete PR/commit file inventories count,
merge commits are excluded from commit fallback, and docs/site/generated files
supply no implementation evidence. A large trivial-commit count alone cannot
produce a share. Unsupported-star severity multiplies the evidence by exp(−3severity).
The co-creator share is S(dominance × identity × work × tenure × substance ×
confidence × inflationMultiplier). Verified first authors retain a separate
founding-provenance path: substance × S(ln(1+commits+3PRs)/ln101) × inflationMultiplier.
Recent documentation work does not erase substantial founding implementation.

Non-founder shares are multiplied by 2tanh(sumShares/2)/sumShares, bounding their
combined credit below two projects. Founders and personal owners do not consume
that co-creator budget. Stars and quality are weighted by the resulting share;
a separately calculated personal-project floor prevents added co-built projects
from reducing the original owner's quality score. The top personal projects keep
their README and community evidence budget; small shares of large external
repositories cannot crowd them out.

Ecology uses s × own-channel + (1−s) × external-channel for each repository,
with existing eligibility gates on each channel, rather than awarding both in
full. Presentation and external-PR counts also use the complementary share.
Legacy snapshots without share metadata retain their historical full-share
interpretation. Public details display “主导/共建（份额 xx%）” / “Led / co-built
(xx% share)”; reports and prompts explicitly forbid claiming sole authorship.

## Combined release gates

The pinned v14 versus complete v15 replay includes all three changes. Require
at least 200 completed, current-hash paired records; lofisu 50–55; asperformias
increasing; asukaminato0721, yifanxuaaa, samzong and hikariming within ±1.5;
median within ±1; and manual inspection of both tails. The six named rows include
all six subscores, P, C, core counts, discount, cap and attributed shares. No
production merge or deployment is authorized by an older, pre-addendum report.
