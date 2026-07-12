---
title: "Who Builds Dify? We Scored Its Top 100 Contributors"
description: "Dify has 148,500 stars and 458 code contributors. We ran its top 100 committers through a deterministic scoring engine: median score 78 vs. a 42.5 global baseline, 71% rank as trusted contributors, and the commit load is unusually well distributed."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Key findings** (data collected 2026-07-11, top 100 committers of [langgenius/dify](https://github.com/langgenius/dify), scored with the open-source [ghfind engine](/methodology)):

- **Dify's top-100 contributors score a median of 78.2 / 100 — 36 points above the 42.5 median of our 18,947-account baseline.** 70.8% clear the "trusted contributor" bar (score ≥ 70) that only 20.1% of the general population reaches.
- **They look like ordinary developers until you look at output.** Median followers: 31 (baseline: 27). Median merged pull requests: 118 (baseline: 20). Dify is built by low-profile, high-throughput professionals, not influencers.
- **The bus factor is unusually healthy for a project this hyped.** The top committer accounts for only 8.4% of top-sample commits, the top three for 21%, the top ten for 49.8%. Compare that to the [one-person-army pattern](/blog/who-builds-openclaw) common among viral AI repos.

## Why Dify

[Dify](https://github.com/langgenius/dify) is one of the most-starred LLM application platforms on GitHub — 148,500 stars, 458 code contributors, created in April 2023. Star counts are the default proxy for project health, and they are also the easiest metric to inflate. So we asked the question stars can't answer: **who actually writes this thing, and do they hold up under a contribution-authenticity audit?**

We took the top 100 contributors by commit count, excluded 3 bots (`dependabot`, `github-actions`, and — a sign of the times — `Copilot`), and scored the remaining 97 humans with our deterministic engine. 96 resolved successfully; 86 have full raw-metric snapshots. The engine is the same one behind every score on this site: 100 points across six dimensions, no model calls, identical inputs give identical outputs.

## Contributor quality: far above baseline

| | Dify top-100 | 19k baseline |
|---|---|---|
| Median score | **78.2** | 42.5 |
| Score ≥ 90 (夯 tier) | **15.6%** | 3.7% |
| Score ≥ 70 (trusted) | **70.8%** | 20.1% |
| Score < 40 (low-value) | **5.2%** | 48.6% |

The distribution barely overlaps the general population's. Even Dify's 10th-percentile contributor (56.1) outscores the global median by 13 points. Fifteen of ninety-six land in the top tier that only one in twenty-seven accounts reaches globally.

The five accounts below 40 are worth a note: every popular repository accumulates a tail of one-commit contributors with thin profiles. Five percent is what that tail looks like on a healthy project — the baseline population is nearly half below 40.

## Quiet professionals

The single most interesting pattern is the gap between visibility and output:

| Median, per contributor | Dify top-100 | 19k baseline |
|---|---|---|
| Followers | 31 | 27 |
| Merged pull requests | **118** | 20 |
| Account age | 9.0 years | 7.4 years |

By follower count, Dify's core contributors are indistinguishable from the average GitHub account. By merged-PR volume they produce **six times** the baseline. This is the inverse of the farming profile our [19k-account study](/blog/we-scored-19000-github-accounts) documented — there, manufactured accounts optimize the visible metrics and skip the work. Dify's contributor base optimizes the work and skips the visibility.

The account-age distribution reinforces it: only 4 of 86 deep-sample accounts are younger than one year. This is not a swarm of fresh accounts chasing a trending repo; the median contributor has been on GitHub since 2017.

## Farming exists even here

Two accounts in the top 100 (2.1%) exceed our farming-pattern threshold (internal spam score ≥ 3) — against 0.58% in the baseline. Re-running the current engine over latest snapshots flags one of them (1.2%). Red flags of any kind hit 13 of 86 accounts (15.1%, baseline 17%), and the composition is dominated by *absence*-type signals (`mostly_forks`: 12) rather than manipulation; exactly one account shows templated-PR flooding and one shows trivial-PR farming.

We report this in aggregate only, but the implication generalizes: **a marquee project's top-100 committer list is not automatically clean.** Popularity attracts pattern-level farming — small template PRs into a high-star repository are the cheapest reputation on the market. That is the problem our upcoming maintainer tooling is built for.

## A genuinely distributed team

Total commits across the top-100 sample: 8,434.

| Concentration | Share of commits |
|---|---|
| Top 1 contributor | 8.4% |
| Top 3 contributors | 21.0% |
| Top 5 contributors | 31.3% |
| Top 10 contributors | 49.8% |

Half the commit mass sits **outside** the top ten. For a 148k-star AI project — a category famous for solo-maintainer burnout risk — that is an unusually resilient shape. The top of the table mixes LangGenius team members with independent community maintainers, and the drop-off from #1 (708 commits) to #10 (249) is gradual, not a cliff.

## The underrated five

The engine's favorite Dify contributors that almost nobody follows — high scores, triple-digit or fewer followers:

| Contributor | Score | Tier | Followers |
|---|---|---|---|
| [linw1995](/u/linw1995) | 96.4 | 夯 | 165 |
| [kurokobo](/u/kurokobo) | 94.3 | 夯 | 116 |
| [junjiem](/u/junjiem) | 93.8 | 夯 | 229 |
| [lin-snow](/u/lin-snow) | 92.3 | 夯 | 152 |
| [WH-2099](/u/WH-2099) | 89.6 | 顶级 | 31 |

Special mention to [bowenliang123](/u/bowenliang123) (94.0, #8 by commits) and [hjlarry](/u/hjlarry) (93.6, #6 by commits): top-ten committers on one of the world's most popular AI projects, each with fewer than 170 followers. If you're hiring, this table is the arbitrage.

## Method and limitations

Scores come from ghfind's deterministic rubric — six dimensions over public GitHub data, no model calls, open source under AGPL. Full rubric and thresholds: [methodology](/methodology). Aggregates behind every table: [data.json](/blog/who-builds-dify/data.json).

- **Top-100 by commits is not the whole community.** Dify has 458 code contributors; we scored the head of the distribution. The tail is likely thinner.
- **Point-in-time.** Data collected 2026-07-11. Star and commit counts move daily; live contributor data lives on the [Dify project page](/developers/repo/langgenius/dify).
- **Commit counts measure volume, not importance.** Bus-factor shares are computed over the top-100 sample and say nothing about who wrote the load-bearing code.
- **Farming counts are aggregate-only by policy.** We identify individuals only in positive contexts.

---

*Browse [Dify's live contributor board](/developers/repo/langgenius/dify), read the [OpenClaw companion study](/blog/who-builds-openclaw), or [score your own GitHub account](/) — the same engine, 20 seconds.*
