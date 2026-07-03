---
title: "Measuring Fabricated Contribution Activity on GitHub: Evidence from 19,000 Deterministically Scored Accounts"
description: "An empirical study of contribution authenticity on GitHub. We score 18,947 public accounts with an open-source deterministic engine and analyze score distributions, the prevalence and structure of pull-request farming, red-flag composition, and the relationship between account age and score."
date: "2026-07-03"
tags: ["data", "github", "anti-abuse", "open-source"]
---

**Abstract.** Concerns about fabricated activity on GitHub — templated pull requests, purchased stars, reciprocal-follow networks — are widespread, but quantitative evidence on its prevalence and structure is scarce. We score 18,947 public GitHub accounts with a deterministic, open-source rubric (no model calls; identical inputs yield identical scores) and retain full raw-metric snapshots for a deep sample of 3,444 accounts. We find that (i) fabrication is rare in our sample: only 0.58% of accounts exceed our conservative farming threshold; (ii) when it occurs, it is extreme and bimodally separated from ordinary behavior — flagged accounts have templated-PR-title ratios above 50% (up to 97%), against a population median of 7%; (iii) low-effort contributions are normal rather than suspicious: 58% of developers with a recent merged-PR sample have at least one trivial external PR, whereas only 0.4% exhibit a majority-trivial pattern at volume; and (iv) the dominant "suspicious-looking" profile is empty rather than manipulated — absence-type red flags outnumber manipulation-type flags by an order of magnitude. Median score increases monotonically with account age, from 18 points below one year to 86 points beyond ten years, consistent with long-horizon consistency being the signal least amenable to fabrication. We discuss implications for the design of spam-detection tooling, in particular that farming is a pattern-level property of an account's history rather than an event-level property of individual contributions.

## 1. Introduction

Assessments of developer credibility increasingly rely on public GitHub activity: hiring pipelines screen candidate profiles, open-source maintainers triage pull requests from unknown contributors, and downstream tooling ranks accounts by apparent impact. Each of these uses creates an incentive to fabricate the underlying signals. Anecdotal reports of star markets, templated pull-request campaigns, and reciprocal-follow schemes are common; systematic measurements of how frequently such fabrication occurs, and what statistical form it takes, are not.

A motivating example from our dataset illustrates the phenomenon. One account presents a merged-PR record that would ordinarily indicate a strong contributor: a large number of merged (not merely opened) pull requests with a near-perfect acceptance rate. Closer inspection shows that 97% of its recent PR titles are near-identical template variants, and that the majority target a single popular repository not owned by the account. No individual pull request is anomalous; the anomaly exists only at the level of the aggregate pattern. This observation — that fabrication may be invisible event-by-event yet conspicuous in aggregate — motivates the present study.

We ask three questions:

1. **Prevalence.** How common is fabricated contribution activity among public GitHub accounts?
2. **Structure.** When fabrication occurs, how does it differ statistically from ordinary contribution behavior?
3. **Composition.** Among accounts that trigger integrity heuristics, what fraction reflect active manipulation versus mere inactivity or absence of original work?

To address them, we score 18,947 public accounts with a deterministic rubric ([ghfind](https://ghfind.com)), whose scoring core is open source under AGPL ([repository](https://github.com/hikariming/ghfind)), and analyze a deep sample of 3,444 accounts for which we retain complete raw-metric snapshots, including PR-level samples, repository quality features, and activity-shape statistics. All aggregate data underlying the figures are published alongside this article ([data.json](/blog/we-scored-19000-github-accounts/data.json)).

Our headline findings: fabrication is substantially rarer in this sample than public discourse suggests; it is extreme rather than subtle when present; and it is nearly linearly separable from honest activity using pattern-level features alone.

## 2. Data and Methodology

### 2.1 Scoring rubric

The engine implements a deterministic rubric over six dimensions summing to 100 points, with additive penalties for red-flag signals. It performs no model calls; scores are fully reproducible from public GitHub data. The same code paths produce the scores used by the ghfind website, the npm/PyPI SDKs, and this analysis.

| Dimension | Max | Signal rewarded |
|---|---|---|
| Contribution quality | 27 | merged PRs (log-scaled), acceptance rate, issue participation |
| Ecosystem impact | 20 | substantive PRs into high-star repositories, maintainer depth |
| Original project quality | 18 | stars weighted by repository substance |
| Activity authenticity | 17 | sustained recent activity, diversity of activity types |
| Account maturity | 10 | account age, years of actual activity |
| Community influence | 8 | followers (log-scaled), follower/following ratio plausibility |

Twelve deterministic red-flag rules subtract points, including `templated_pr_flooding`, `trivial_pr_farming`, `follow_farming`, and `possible_star_inflation`. Exact thresholds are available in the repository. In addition to the public score, the engine computes an internal spam/bot-likelihood score on a 0–10 scale, used to protect leaderboard integrity; Section 3.2 reports its distribution for the first time. No other non-public data enter this analysis.

**Definitions.** We call a pull request *trivial* if it changes at most five lines and is merged into a repository with at least 200 stars that the author does not own. The *templated-title ratio* of an account is the fraction of its recent PR titles that are near-identical template variants of one another.

### 2.2 Sample construction and known biases

The sample comprises (a) users who voluntarily scored their own accounts through the ghfind website and (b) developers ingested from active open-source organizations. Two properties of this design constrain interpretation. First, the sample is self-selected and skews toward genuine, active developers; every fabrication rate reported below should therefore be read as a **lower bound within an already-filtered population**, not as a GitHub-wide estimate. Second, at 18,947 scored accounts (3,444 with deep metrics), the sample is large enough to characterize distributional shape but is a negligible fraction of GitHub; we report shapes, not a census.

## 3. Results

### 3.1 Score distribution

![Final score distribution across 19k accounts](/blog/we-scored-19000-github-accounts/score-distribution.svg "Figure 1: Distribution of final scores in 5-point buckets (n = 18,947). Orange bands mark the 70+ tiers.")

*Figure 1* shows the distribution of final scores. The median lies just above 40 points; **48.6%** of accounts score below 40 (the tier the rubric labels low-value or suspected padding), while only **3.7%** exceed 90. The single most populated bucket is 0–5, consisting of accounts with no original work, no merged pull requests, and no sustained activity. Even in a sample biased toward active developers, most public profiles are thin.

For calibration, the median account in the deep sample has **27 followers, 34 total stars, and 20 merged PRs**, at a median account age of seven years. Reputation-relevant metrics are heavily concentrated in the upper tail: the 90th percentile is 1,275 followers and roughly 5,900 stars; the 99th percentile is 19,000 followers and roughly 100,000 stars.

### 3.2 Prevalence and structure of farming

![Hidden spam-score distribution](/blog/we-scored-19000-github-accounts/spam-score.svg "Figure 2: Distribution of the internal 0–10 spam-likelihood score (n = 18,934). 77% of accounts score exactly 0.")

*Figure 2* reports the distribution of the internal spam-likelihood score across the 18,934 accounts for which it was computed:

- **77%** of accounts score exactly 0 — no farming signal of any kind.
- **0.58%** (110 accounts) score 3 or higher, the threshold we treat as clear farming.
- **12 accounts** score 7 or higher.

The separability of farming accounts derives not from their volume but from their *concentration*. Among the 2,122 developers with at least ten recent pull requests, the median templated-title ratio is **7%** — ordinary developers repeat themselves modestly ("fix typo", "bump deps"). Every account flagged for template flooding has a ratio above **50%**, ranging to **97%**, while the 99th percentile of the full population is 72%. The distribution is effectively bimodal: there is no continuum between ordinary repetition and batch generation. Detecting these accounts requires no learned model — only aggregation across more than one pull request per account.

### 3.3 Trivial pull requests are normal; trivial-PR farming is not

Of the 2,558 developers with a recent merged-PR sample, **58%** have at least one trivial external PR as defined in Section 2.1. Small documentation and typo fixes into prominent repositories are evidently a routine part of open-source participation, including for otherwise strong contributors.

By contrast, developers whose recent merged PRs are *majority*-trivial with at least ten such PRs constitute **0.4%** of the sample (11 accounts).

The gap between these two figures has direct design consequences for anti-abuse tooling. Any heuristic that penalizes small pull requests per se penalizes the 58% — newcomers, documentation contributors, and incidental helpers — in order to catch eleven accounts whose behavior was already conspicuous at the pattern level. We conclude that farming is a **pattern property** of an account's contribution history (concentration, templating, repetition against a single target) rather than an **event property** of any individual diff, and that detectors operating on single events measure the wrong quantity.

A parallel result holds for rejection rates. Among the 2,003 developers with at least ten decided PRs, the median maintainer-rejection rate is **2%**, with a 90th percentile of 13%. Acceptance rate therefore carries little discriminative signal — conditional on having merged PRs at all, nearly everything such contributors submit is merged — and only extreme rejection rates (the rubric flags above 50%) are informative.

### 3.4 Red-flag composition: absence dominates manipulation

Re-running the current engine over all 3,444 deep-sample accounts, **17%** trigger at least one red flag. *Figure 3* shows the composition.

![Red-flag prevalence](/blog/we-scored-19000-github-accounts/red-flags.svg "Figure 3: Red-flag prevalence in the deep sample (n = 3,444). Absence-type flags exceed manipulation-type flags by an order of magnitude.")

The three most prevalent flags — `ghost_profile` (10%), `no_original_work` (8.2%), and `mostly_forks` (7.2%) — describe absence of substance rather than manipulation. Active-deception flags are an order of magnitude rarer: `templated_pr_flooding` at 0.5%, `trivial_pr_farming` at 0.3%, `follow_farming` at 0.1%. Star inflation — high star counts with near-zero forks and issues — rounds to zero in this sample, though self-selection plausibly suppresses it: accounts with purchased stars are unlikely to submit themselves for scoring.

For trust tooling built on GitHub data, this composition implies two qualitatively different failure modes requiring different detectors and different error tolerances: the frequent, cheap case ("nothing is here") and the rare, expensive case ("something here was manufactured").

### 3.5 Account age as a non-forgeable signal

![Median score by account age](/blog/we-scored-19000-github-accounts/age-vs-score.svg "Figure 4: Median final score by account age. The relationship is monotonic across all age buckets.")

Median score rises monotonically with account age, from **18 points for accounts under one year to 86 for accounts past their tenth year**, with no intermediate decline (*Figure 4*). Survivorship contributes to this relationship — old accounts that appear in the sample are old accounts still in use — but the direction of the effect is itself informative. Every component of long-horizon consistency (years of activity, aged repositories with organically accumulated stars, contribution histories spanning many releases) is precisely what fabrication cannot compress: stars and followers can be acquired within hours, whereas a 2015 account with nine years of activity cannot be minted in 2026. This asymmetry justifies the rubric's weighting of account maturity and activity span, and is consistent with our observation that flagged flooding accounts cluster among young accounts.

As a secondary observation, the primary-language composition of high-scoring accounts (final score ≥ 60) follows familiar ecosystem trends: **TypeScript (520), Python (460), and JavaScript (395)** lead, with Rust (225) ahead of Go (189), C (184), and Java (159) (*Figure 5*).

![Languages of high scorers](/blog/we-scored-19000-github-accounts/languages.svg "Figure 5: Primary languages among accounts scoring 60 or above.")

## 4. Discussion

Three design principles for contribution-integrity tooling follow from the results.

**Detect patterns, not events.** The bimodal separation in Section 3.2 and the 58%-versus-0.4% gap in Section 3.3 indicate that individual contributions carry almost no fabrication signal, while account-level aggregates separate cleanly. Single-event heuristics maximize false positives against exactly the contributors — newcomers and low-volume helpers — whom open-source projects most need to retain.

**Distinguish absence from manipulation.** Most accounts that fail integrity checks are empty, not adversarial (Section 3.4). Conflating the two inflates apparent fraud rates and misallocates review effort.

**Weight time.** Longitudinal consistency is the only examined signal whose acquisition cost cannot be reduced by expenditure (Section 3.5), making it the natural anchor for any credibility score.

Guided by these principles, we are building a GitHub App to assist maintainers in triaging spam pull requests, combining PR-level features (diff size, template similarity) with author-level history. Given the false-positive risk documented in Section 3.3, the tool will not auto-close pull requests; it surfaces evidence for human decision. We invite maintainers of affected repositories to share examples of the spam they receive.

## 5. Limitations

- **Self-selected sample.** Website users plus members of active open-source organizations skew genuine and active. GitHub-wide fabrication rates are plausibly higher than those reported here; our percentages are lower bounds within a filtered population.
- **Scale.** 18,947 scored accounts, 3,444 with deep metrics. Distributional shapes are stable across re-runs, but the sample is not representative of GitHub as a whole.
- **Aggregate reporting only.** All patterns are reported in aggregate; no individual accounts are identified. Flag thresholds are published so that maintainers can apply them with context.
- **Engine versioning.** Red-flag prevalence was recomputed with the current scorer over each account's latest raw snapshot; stored spam scores reflect the engine version at scan time. Both are included in the [published aggregates](/blog/we-scored-19000-github-accounts/data.json).

## 6. Reproducibility

All scoring logic is deterministic and open source (AGPL) at [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind). The identical engine is distributed via `npm install ghfind` and `pip install ghfind`, and can be run either against the public API ([OpenAPI specification](https://ghfind.com/openapi.json)) or fully locally with a user-supplied GitHub token. The aggregate statistics behind every figure in this article are available as [data.json](/blog/we-scored-19000-github-accounts/data.json).

*Individual accounts can be scored at [ghfind.com](https://ghfind.com).*
