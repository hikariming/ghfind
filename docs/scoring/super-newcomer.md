# Super newcomer maturity bonus (score v11)

## Design goal

Recognize unusually strong public work completed early in an account's life,
without replacing the v10 rubric, weakening risk deductions, or awarding points
for youth alone. The same rule applies to every account. It is not a percentile
estimate or a prediction of future performance.

All six dimension maxima, tier thresholds, and v10 risk rules remain unchanged.
Only account maturity receives an additive bonus; maturity stays capped at 10
and the final score at 100. Community influence is not used to qualify.

## Formula

Preserve the original maturity baseline:

```text
default maturity = 7 * min(account_age_years / 6, 1) + active-calendar-year points
active-calendar-year points = 0 / 1 / 2 / 3 for 0 / 1 / 2 / 3+ years
```

For eligible accounts, with age t in years:

```text
bonus = 4 * strength * evidence_confidence * (1 - t / 3)^2
new maturity = round_half_even(min(10, raw default maturity + bonus), 1)
```

At age 3 or older the bonus is exactly zero, not an indefinitely lingering
exponential. Its value and age derivative both approach zero at age 3. This
smoothly joins the original curve, apart from the original one-decimal rounding
and active-calendar-year steps, which this change deliberately preserves.
If the bonus is zero, retain the original maturity rounding path exactly.

### Strength: the weakest dimension limits the bonus

Normalize four existing signals, without changing their baseline formulas:

- Original-project substance: best_original_repo_quality_score (0..1).
- Contribution quality: the existing capped contribution_quality subscore / 27.
- Ecosystem: EITHER multi-repo depth (impact_depth_raw / 8) OR landed work
  volume in star-qualified repos (log-ratio of impact_commit_count +
  impact_pr_count, full credit at 400). The two paths take the maximum before
  the strength ramp: a creator maintaining one exceptional repo is not weaker
  than a contributor touching many, matching the dimension's own philosophy
  that ecosystem impact includes both contributor and maintainer value.
  Volume only counts work that already passed the same >=200-star external /
  >=1000-star own gates, so it cannot be farmed in small or self-created
  low-star repos.
- Activity authenticity: the existing activity_authenticity subscore / 17.

For each normalized value v, compute:

```text
x = clamp((v - 0.55) / 0.30, 0, 1)
ramp(v) = x^2 * (3 - 2*x)
strength = min(ramp(v) across the four signals)
```

No bonus is unlocked when any signal is at or below 55%. A weakest signal of
70% earns half strength; all four at least 85% earn full strength. Smoothstep
avoids a threshold windfall. High stars or followers cannot replace weak
project substance, contribution quality, ecosystem depth, or activity.

This is not mathematically star-invariant: the unchanged contribution formula
and the collector's impact definitions still contain existing prestige/star
signals. The rest of the scoring system is intentionally not reinterpreted.
The project-substance and ecosystem-depth bonus inputs themselves are not the
star-weighted dimension totals; a useful zero-star project is not disqualified.

### Evidence confidence: do not assume unmeasured work is verified

```text
confidence = min(
  clamp(verified_impact_pr_count / 5, 0, 1),
  clamp(core_impact_pr_count / 3, 0, 1),
  clamp(recent_merged_pr_sample / 20, 0, 1)
)
```

Missing or non-finite evidence earns zero credit. Small measured samples earn
proportionately less credit, rather than immediately unlocking four points.
The existing core_impact_pr_count is a non-doc-like classification proxy, not a
full code audit; this mechanism does not claim otherwise. It is deliberately
an evidence-backed, well-rounded newcomer category, not a bonus for every solo
maintainer. Accounts without sampled impact PRs retain their original scores.
The volume path does not change this: a solo maintainer whose repos never
reached the star gates still earns no bonus, and heavy volume with weak
project substance or any contribution-family risk signal still scores zero.

### Eligibility and risk

A bonus also requires:

- A finite, non-negative age under 3, and a calendar-valid GitHub UTC registration
  timestamp (YYYY-MM-DDTHH:MM:SSZ). Missing age evidence is not exceptional youth.
- At least one nonempty original repository.
- Known last activity between 0 and 90 days ago. This uses the existing rubric's
  recent-activity window; passing 90 days removes the extra bonus.
- Completed merged-PR aggregation, no star-inflation suspicion, and zero applied
  risk penalty.
- No contribution-family risk signal, including warning-only signals with zero
  deduction. A lack of penalty is not proof of clean contribution evidence.

Footprint-only notes, such as many repositories on a young account, do not
block the bonus. Neither does an isolated follow-imbalance note: small following
counts are not proof of fraud, and followers do not qualify accounts. Existing
paired social-risk deductions still block the bonus. Unavailable commit
aggregation alone does not discard independently sampled PR evidence.

## Size and aging examples

Maximum unrounded bonus when strength and confidence both equal 1:

| Account age | Maximum bonus |
| --- | ---: |
| 1 month | +3.78 |
| 3 months | +3.36 |
| 6 months | +2.78 |
| 1 year | +1.78 |
| 1.5 years | +1.00 |
| 2 years | +0.44 |
| 2.5 years | +0.11 |
| 3+ years | +0.00 |

The displayed change may differ by about 0.1 due to existing one-decimal
maturity rounding. Four points is an upper bound, not an automatic grant.

Holding evidence and strength constant, the bonus decreases monotonically.
The total score need not: normal maturity and new active calendar years can
increase at the same time. Improving work may raise strength or confidence and
offset decay while the account is young, but can never extend the 3-year window.

The scorer uses a single snapshot and never reads the system clock. It cannot
infer growth or stagnation relative to a previous scan. Advancing age requires
fresh collection; re-scoring an unchanged archived snapshot must remain
reproducible, not silently age or invent history.

## Validation and rollout

The TS site/JS local SDK, Go scorer, and Python SDK use the same rule and share
42 regression cases in src/lib/__tests__/newcomer-score-fixtures.json. Tests
cover aging, partial strength, limited/missing evidence, benign notes, risk
vetoes, malformed dates, unchanged baseline dimensions, bounds, and adversarial
volume-path cases (heavy landed work with weak project substance, and heavy
landed work alongside trivial-PR risk; both must stay at zero). Existing
score fixtures are unchanged.

Advance score/cache version only, to v11. Keep risk v10, roast v11, and collection
versions unchanged. See [rollout and rollback](../releases/v11-v11-v5-rollout.md).
