---
title: "Who Builds Dify? We Scored Its Top 100 Contributors"
description: "Dify has 148,500 stars and 458 code contributors. We ran its top 100 committers through a deterministic scoring engine: median score 78 vs. a 42.5 global baseline, 71% rank as trusted contributors, and the work is spread across far more people than usual."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Key findings** (data collected 2026-07-11, top 100 committers of [langgenius/dify](https://github.com/langgenius/dify), scored with the open-source [ghfind engine](/methodology)):

- **Dify's top-100 contributors score a median of 78.2 / 100 — 36 points above the 42.5 median of our 18,947-account baseline.** 70.8% clear the "trusted contributor" bar (score ≥ 70) that only 20.1% of the general population reaches.
- **They look like ordinary developers until you look at their output.** Median followers: 31 (baseline: 27). Median merged pull requests: 118 (baseline: 20). Dify is built by quiet but prolific professionals, not by anyone you'd recognize from social media.
- **No single person dominates the codebase — rare for a project this famous.** The most active committer wrote only 8.4% of the commits, the top three wrote 21%, the top ten just under half. Compare that with [viral AI projects that are mostly one person's work](/blog/who-builds-openclaw).

## Why Dify

[Dify](https://github.com/langgenius/dify) is one of the most-starred LLM application platforms on GitHub — 148,500 stars, 458 code contributors, created in April 2023. Star counts are the default way people judge a project's health, and they are also the easiest number to inflate. So we asked the question stars can't answer: **who actually writes this thing, and do they hold up when you check whether their track record is real?**

We took the top 100 contributors by commit count, excluded 3 bots (`dependabot`, `github-actions`, and — a sign of the times — `Copilot`), and scored the remaining 97 humans with our deterministic engine. 96 resolved successfully; 86 have full raw-metric snapshots. The engine is the same one behind every score on this site: 100 points across six dimensions, no model calls, identical inputs give identical outputs.

## Contributor quality: far above baseline

| | Dify top-100 | 19k baseline |
|---|---|---|
| Median score | **78.2** | 42.5 |
| Score ≥ 90 (夯 tier) | **15.6%** | 3.7% |
| Score ≥ 70 (trusted) | **70.8%** | 20.1% |
| Score < 40 (low-value) | **5.2%** | 48.6% |

The two distributions barely overlap. Even Dify's 10th-percentile contributor (56.1) outscores the global median by 13 points. Fifteen of the ninety-six score 90 or above — a bar that only one GitHub account in twenty-seven clears.

The five accounts below 40 deserve a note too: every popular repository picks up a tail of people who landed one commit and have little else on their profile. On a healthy project, that tail is about 5% of the top contributor list. In the baseline population, nearly half of all accounts sit below 40.

## Quiet professionals

The most interesting pattern is the gap between how visible these people are and how much they produce:

| Median, per contributor | Dify top-100 | 19k baseline |
|---|---|---|
| Followers | 31 | 27 |
| Merged pull requests | **118** | 20 |
| Account age | 9.0 years | 7.4 years |

By follower count, Dify's core contributors are indistinguishable from the average GitHub account. By merged pull requests, they produce **six times** the baseline. This is the exact opposite of the faked-activity profile our [19k-account study](/blog/we-scored-19000-github-accounts) documented — manufactured accounts polish the numbers everyone can see and skip the actual work. Dify's contributors do the work and skip the self-promotion.

The account ages tell the same story: only 4 of the 86 accounts with full data are younger than one year. This is not a crowd of fresh accounts chasing a trending repository — the typical contributor has been on GitHub since 2017.

## Fake activity shows up even here

Two accounts in the top 100 (2.1%) exceed the threshold our engine uses for farming — the practice of manufacturing a contribution history out of low-effort, repetitive pull requests. In the baseline population that rate is 0.58%. Re-running the current engine over the latest snapshots flags one of the two (1.2%). Warning signals of any kind appear on 13 of 86 accounts (15.1%, baseline 17%), but almost all of them say "this profile is thin" (`mostly_forks`: 12) rather than "this profile is fake": exactly one account shows mass-produced PR titles, and one shows a history built on trivial PRs.

We report this only in aggregate, but the general point stands: **being a famous project does not keep your top-100 contributor list clean.** Popularity attracts this behavior, because tiny template PRs merged into a famous repository are the cheapest résumé line on the market. That is precisely the problem our upcoming tool for maintainers is built to catch.

## Built by many hands

Total commits across the top-100 sample: 8,434.

| Share of commits | |
|---|---|
| Most active contributor | 8.4% |
| Top 3 | 21.0% |
| Top 5 | 31.3% |
| Top 10 | 49.8% |

More than half of all commits come from **outside** the top ten. Famous AI projects usually rest on one or two exhausted maintainers, and stop moving when those people do; Dify spreading its work this widely makes it unusually hard to break. The top of the table mixes LangGenius employees with independent community maintainers, and the drop from #1 (708 commits) to #10 (249) is a gentle slope, not a cliff.

## The underrated five

The contributors our engine rates highest and almost nobody follows:

| Contributor | Score | Tier | Followers |
|---|---|---|---|
| [linw1995](/u/linw1995) | 96.4 | 夯 | 165 |
| [kurokobo](/u/kurokobo) | 94.3 | 夯 | 116 |
| [junjiem](/u/junjiem) | 93.8 | 夯 | 229 |
| [lin-snow](/u/lin-snow) | 92.3 | 夯 | 152 |
| [WH-2099](/u/WH-2099) | 89.6 | 顶级 | 31 |

Special mention to [bowenliang123](/u/bowenliang123) (94.0, #8 by commits) and [hjlarry](/u/hjlarry) (93.6, #6 by commits): top-ten committers on one of the world's most popular AI projects, each with fewer than 170 followers. If you're hiring, start with this table — these people are far better than their follower counts suggest.

## Method and limitations

Scores come from ghfind's deterministic rubric — six dimensions over public GitHub data, no model calls, open source under AGPL. Full rubric and thresholds: [methodology](/methodology). The aggregates behind every table: [data.json](/blog/who-builds-dify/data.json).

- **Top-100 by commits is not the whole community.** Dify has 458 code contributors; we scored the most active end. The long tail of occasional contributors likely scores lower.
- **This is a snapshot.** Data collected 2026-07-11. Stars and commits move daily; live contributor data lives on the [Dify project page](/developers/repo/langgenius/dify).
- **Commit counts measure volume, not importance.** The share-of-commits table says who committed most, not who wrote the code everything else depends on.
- **Fake-activity findings are reported in aggregate only.** We name individuals only when the news is good.

---

*Browse [Dify's live contributor board](/developers/repo/langgenius/dify), read the [OpenClaw companion study](/blog/who-builds-openclaw), or [score your own GitHub account](/) — same engine, 20 seconds.*
