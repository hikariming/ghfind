---
title: "We scored 19,000 GitHub accounts for real contribution. Faking is rare — but extreme."
description: "Score distributions, PR-farming anatomy, star inflation and a decade-long credibility curve: aggregate findings from deterministically scoring 19,000 GitHub accounts with an open-source engine."
date: "2026-07-03"
tags: ["data", "github", "anti-abuse", "open-source"]
---

One account in our dataset has a merged-PR history most developers would envy. Merged — not just opened; its acceptance rate looks spotless. But 97% of its recent PR titles are near-identical template variations, and the bulk of them target a single popular repository it doesn't own. Every individual PR looks plausible; the *pattern* is unmistakable: an AI-assisted contribution farm, speedrunning a credible-looking GitHub profile.

That account is why we started measuring. Over the past weeks, [ghfind](https://ghfind.com) scored **18,947 public GitHub accounts** with a deterministic engine — no LLM in the scoring core, every number reproducible from public data. For 3,444 of them we keep full raw-metric snapshots (PR-level samples, repo quality features, activity shape), which lets us ask a question we haven't seen answered with data in one place:

**How common is faked GitHub contribution, and what does it actually look like?**

The short version: much rarer than the discourse suggests, far more extreme when it does happen, and almost trivially separable from honest work — if you look at patterns instead of single events.

## How we score (so you can judge the data)

The engine implements a deterministic rubric across six dimensions, summing to 100, with penalties for red flags. No model calls, no vibes; the same inputs always produce the same score. The core is open source (AGPL) in [the ghfind repo](https://github.com/hikariming/ghfind), and the same code paths power the site, the npm/PyPI SDKs, and this analysis.

| Dimension | Max | What it rewards |
|---|---|---|
| Contribution quality | 27 | merged PRs (log-scaled), acceptance rate, issues |
| Ecosystem impact | 20 | substantial PRs into high-star repos, maintainer depth |
| Original project quality | 18 | stars *times* repo substance (a starred empty shell scores low) |
| Activity authenticity | 17 | sustained recent activity, diversity of activity types |
| Account maturity | 10 | account age, years actually active |
| Community influence | 8 | followers (log-scaled), follower/following sanity |

On top of that, twelve deterministic red flags subtract points — things like `templated_pr_flooding`, `trivial_pr_farming`, `follow_farming`, `possible_star_inflation`. Full thresholds are in the repo; nothing in this post uses hidden data beyond one internal spam score we'll get to below.

Two honest caveats before the charts. First, this is not a random sample of GitHub: it's people who scored themselves on a roast site, plus developers we ingested from active open-source organizations. That skews *toward* real, active developers — so every farming rate below is best read as a **lower bound for an already-filtered population**. Second, 19k accounts is a lot of scans but a tiny slice of GitHub; we're publishing the shape, not the census.

## Half of scored accounts land below 40

![Final score distribution across 19k accounts](/blog/we-scored-19000-github-accounts/score-distribution.svg "Distribution of final scores, 5-point buckets. Orange bands are the 70+ tiers.")

The median scored account sits just above 40 points. **48.6%** of accounts score below 40 — the tier we bluntly label "low value / suspected padding" — while only **3.7%** clear 90. Even in a sample biased toward genuinely active developers, most public GitHub profiles are thin: the single biggest score bucket is 0–5, populated by accounts with no original work, no merged PRs, and no sustained activity.

For calibration, the median account in our deep sample has **27 followers, 34 total stars, and 20 merged PRs** — after seven years on the platform. If your numbers look like that, you're not behind; you're the median. The long tail does the reputational heavy lifting: p90 is 1,275 followers and ~5,900 stars, p99 is 19,000 followers and ~100,000 stars.

## Hard farming: 0.6% of accounts, impossible to miss

Alongside the public score, the engine computes an internal 0–10 spam/bot likelihood that we've never exposed anywhere — it exists purely so the leaderboards can quietly resist manipulation. Publishing its distribution for the first time:

![Hidden spam-score distribution](/blog/we-scored-19000-github-accounts/spam-score.svg "77% of accounts score a flat 0. The tail is small — and vivid.")

- **77%** of accounts score exactly 0 — no farming signal at all.
- **0.58%** (110 of 18,934) reach 3+, our "clearly farming" line.
- **12 accounts** reach 7+, the full-conviction zone.

What makes the farmers easy to catch isn't their volume — it's their *concentration*. Among 2,122 developers with at least ten recent PRs, the **median templated-title ratio is 7%**. Humans repeat themselves a little ("fix typo", "bump deps"). The flagged flooders all sit above **50%**, ranging up to **97%** (the 99th percentile of the whole population is 72%) — there is essentially no middle ground between "normal repetition" and "batch generation". The distribution isn't a slope, it's two islands. You don't need machine learning to find these accounts; you need to look at more than one PR at a time.

## The finding that changed our roadmap: trivial PRs are normal

Here's the number that surprised us most. Of 2,558 developers with a recent merged-PR sample, **58% have at least one trivial PR** — a ≤5-line change merged into someone else's 200+ star repository. A typo fix in a famous repo is apparently a rite of passage.

But developers whose recent merged PRs are *majority* trivial, with ten or more of them? **0.4%** (11 accounts).

This gap is the entire design brief for anti-spam tooling. Every heuristic that punishes "small PRs" punishes the 58% — the newcomers, the docs fixers, the drive-by helpers open source depends on — to catch eleven farmers who were never subtle to begin with. Farming is a *pattern property* (concentration, templating, repetition against one target), not an *event property* (one small diff). Any spam detector that fires on a single PR is measuring the wrong thing.

The same logic clears another popular suspicion: PR rejection. Among 2,003 developers with ten or more decided PRs, the **median maintainer-rejection rate is 2%**, and p90 is only 13%. Maintainers merge almost everything from people whose PRs get merged at all — so "high acceptance rate" is a nearly useless credential, and only *extreme* rejection (we flag above 50%) carries signal.

## Most "fake-looking" accounts aren't farming — they're empty

Re-running the current engine over all 3,444 deep-sample accounts, **17%** trigger at least one red flag. The composition is the interesting part:

![Red-flag prevalence](/blog/we-scored-19000-github-accounts/red-flags.svg "Emptiness beats manipulation by an order of magnitude.")

The top three flags — `ghost_profile` (10%), `no_original_work` (8.2%), `mostly_forks` (7.2%) — describe *absence*, not manipulation. Active deception (`templated_pr_flooding` 0.5%, `trivial_pr_farming` 0.3%, `follow_farming` 0.1%) is an order of magnitude rarer. Star inflation — high stars with near-zero forks and issues — rounds to zero in this sample, though we'd expect self-selection to hide it: people who bought stars don't roast themselves.

If you're building trust tooling on top of GitHub data, this composition matters: the common failure mode you'll encounter is "there's nothing here", and the expensive-but-rare failure mode is "someone manufactured something here". They need different detectors and very different error tolerances.

## The one signal money can't buy: a decade

![Median score by account age](/blog/we-scored-19000-github-accounts/age-vs-score.svg "Median final score climbs monotonically with account age.")

Median score climbs from **18 points for accounts under a year old to 86 for accounts past their tenth year** — monotonically, no dips. Some of that is survivorship (old accounts that still get scored are old accounts still in use). But it's also the point: every component of long-horizon consistency — years of activity, aged repos with organic stars, a contribution graph that spans releases — is precisely what a farm can't compress. Stars can be bought this afternoon and followers by tonight. A 2015 account with nine active years cannot be minted in 2026.

That's why account maturity and activity-span carry real weight in the rubric, and why the flooders cluster in young accounts trying to fake the only thing that can't be faked quickly.

As a side note, the high scorers' language mix will surprise no one who's watched the last five years — **TypeScript (520), Python (460), and JavaScript (395)** lead among accounts scoring 60+, with Rust (225) now firmly ahead of Go (189), C (184) and Java (159):

![Languages of high scorers](/blog/we-scored-19000-github-accounts/languages.svg "Primary languages among accounts scoring 60+.")

## What we're doing with this

Everything above is deterministic and reproducible: `npm install ghfind` or `pip install ghfind` gives you the same scoring engine, either against our API or fully local with your own GitHub token — the scoring core ships inside the package, and [it's AGPL on GitHub](https://github.com/hikariming/ghfind). There's a public score API with an [OpenAPI spec](https://ghfind.com/openapi.json), plus a README badge if you want your score on your profile.

The next thing we're building on this engine is the part the data argues for: a GitHub App that helps open-source maintainers triage spam PRs — combining PR-level signals (diff size, template similarity) with author-level history, and *never* auto-closing anything, because the 58% finding above says false positives hurt exactly the people open source needs most. If you maintain a repo that gets farmed, we'd like to hear what your spam looks like.

## Limitations, honestly

- **Self-selected sample.** Roast-site users plus active OSS org members skew real and active. GitHub-wide farming rates are certainly higher than ours; treat our percentages as lower bounds within a filtered population.
- **Scale.** 19k scored accounts, 3.4k with deep metrics. The shapes are stable across re-runs, but this is a telescope, not a survey.
- **No name-and-shame.** All patterns are reported in aggregate. The point is the shape of the data, not any individual account — flag thresholds exist so maintainers can make their own calls with context.
- **Engine version.** Red-flag prevalence was recomputed with the current scorer over each account's latest raw snapshot; the stored spam scores reflect the engine at scan time. Both are in the [raw aggregates](/blog/we-scored-19000-github-accounts/data.json) if you want to check our math.

*Scored yourself yet? [ghfind.com](https://ghfind.com) — the roast is free and the engine holds no grudges.*
