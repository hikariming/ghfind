---
title: "382,000 Stars, One Pair of Hands: Who Actually Builds OpenClaw?"
description: "OpenClaw became the fastest-growing repository in GitHub history. We scored its top 100 contributors with a deterministic engine: one person wrote 57% of the commits, zero contributors show farming patterns, and a fifth of them joined GitHub less than a year ago."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Key findings** (data collected 2026-07-11, top 100 committers of [openclaw/openclaw](https://github.com/openclaw/openclaw), scored with the open-source [ghfind engine](/methodology)):

- **The fastest-growing repository in GitHub history is, by commit mass, mostly one person.** Creator [steipete](/u/steipete) wrote 33,482 of the top-sample's 58,487 commits — **57.2%**. The top three contributors account for 81.5%, the top ten for 90.2%.
- **Zero farming.** Not a single one of the 96 human top-100 contributors exceeds our farming-pattern threshold — against 0.58% even in our self-selected 18,947-account baseline. The hype is enormous; the contributor list behind it is clean.
- **The AI-agent wave is pulling newcomers into open source.** 19.6% of top contributors' accounts are less than a year old (at Dify, an older project of comparable fame, it's 4.7%). Some of them are already elite: the #3 committer runs a 2.3-year-old account that scores 94.1.

## Why OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) needs little introduction: created on 2025-11-24 by Peter Steinberger ([steipete](/u/steipete), founder of PSPDFKit), renamed twice in a single week of January 2026 (Clawdbot → Moltbot → OpenClaw), and the fastest project ever to 100,000 GitHub stars. As of 2026-07-11 it stands at **382,580 stars, 80,292 forks, and 368 code contributors** — about seven and a half months after the first commit.

A star curve like that is precisely the situation our engine was built for: when a number goes vertical, is there anything real underneath? We took the top 100 contributors by commit count, excluded 4 bots (including the project's own `clawsweeper` and `openclaw-clownfish`), and scored all 96 humans. 92 have full raw-metric snapshots.

## Contributor quality: the head is elite

| | OpenClaw top-100 | Dify top-100 | 19k baseline |
|---|---|---|---|
| Median score | **79.7** | 78.2 | 42.5 |
| Score ≥ 90 (夯 tier) | **21.9%** | 15.6% | 3.7% |
| Score ≥ 70 (trusted) | **69.8%** | 70.8% | 20.1% |
| Score < 40 (low-value) | **9.4%** | 5.2% | 48.6% |

(The Dify column comes from [our companion study](/blog/who-builds-dify), scored the same week with the same engine.)

One in five OpenClaw top contributors lands in the top tier that one in twenty-seven accounts reaches globally. The people who show up to build the hottest repository on GitHub are disproportionately excellent — vertical attention recruits vertical talent. But note the other tail: 9.4% score below 40, nearly double Dify's rate. A hype magnet attracts thin profiles too; more on the age structure below.

## One pair of hands

Total commits across the top-100 sample: 58,487 — seven times Dify's 8,434, in a fifth of the calendar time.

| Concentration | OpenClaw | Dify |
|---|---|---|
| Top 1 | **57.2%** | 8.4% |
| Top 3 | **81.5%** | 21.0% |
| Top 5 | **86.0%** | 31.3% |
| Top 10 | **90.2%** | 49.8% |

[steipete](/u/steipete)'s 33,482 commits over 229 days average **146 commits per day**. That is not a human typing rate; it's a human *reviewing* rate — OpenClaw is famously built by its own agents under their creator's direction, and the commit log is what AI-amplified solo development looks like at full throttle. The engine gives the account a **100/100** — a 17-year GitHub history, 52,067 followers, 2,772 merged PRs — the polar opposite of a bot pattern. The scale is real; it is just concentrated in one pair of hands to a degree no 380k-star project has ever been.

The next tier down is thin but serious: [vincentkoc](/u/vincentkoc) (10,502 commits, score 96.5), [shakkernerd](/u/shakkernerd) (3,688, score 94.1), [obviyus](/u/obviyus) (1,771, score 93.2). After #10, no contributor holds even 0.5% of the commit mass.

Both structures ship: Dify runs a genuinely distributed contributor economy; OpenClaw runs a benevolent-dictator machine at unprecedented cadence. But they carry different risks, and a star count of 148k vs 382k tells you nothing about which risk you're adopting.

## Zero farming — and why that's still worth saying

Across all 96 humans: **zero** accounts at or above our farming threshold (internal spam score ≥ 3), stored or recomputed. Red flags hit 19 of 92 (20.7%), but the composition is entirely *absence*-type or rejection-related — `mostly_forks` (15), `no_original_work` (10), `high_pr_rejection` (4) — with **no** templated-PR flooding and **no** trivial-PR farming. For calibration, even Dify's top-100 carried two farming-pattern accounts, and the baseline rate is 0.58%.

One honest caveat: commit-ranked top-100 is a hostile habitat for farmers, whose signature is one or two trivial PRs per repository — OpenClaw's #100 contributor has 24 commits. Farming, if present, lives in the long tail of 368 contributors and in the [2,800+ anonymous email identities](https://github.com/openclaw/openclaw/graphs/contributors) beyond it. What this result rules out is something subtler: that OpenClaw's meteoric numbers were built by a manufactured contributor cloud. They weren't. The head of this project is verifiably real.

## The newcomer wave

Account-age distribution is where OpenClaw stops looking like Dify entirely:

| | OpenClaw | Dify |
|---|---|---|
| Accounts < 1 year old | **19.6%** | 4.7% |
| Accounts < 2 years old | **26.1%** | 9.3% |
| Median account age | 8.7 years | 9.0 years |

The distribution is bimodal: a veteran core (median tenure since 2017) plus a fifth of contributors whose GitHub accounts didn't exist when ChatGPT turned two. These are people the AI-agent moment pulled into open source — and they're not tourists. The standout is [shakkernerd](/u/shakkernerd): a 2.3-year-old account, 362 followers, and the #3 commit slot on the biggest repository of the year, scoring 94.1. The thin-profile tail (9.4% under 40 points) is the same wave's other edge: brand-new accounts whose first-ever open-source activity is a small OpenClaw fix. A year from now they'll either have grown histories or gone quiet; we'll re-run the numbers.

## The underrated five

Top-tier scores, minimal followings — the OpenClaw regulars nobody is watching:

| Contributor | Score | Tier | Followers | Commits here |
|---|---|---|---|---|
| [RomneyDa](/u/RomneyDa) | 98.4 | 夯 | 169 | 290 |
| [altaywtf](/u/altaywtf) | 97.7 | 夯 | 273 | 66 |
| [osolmaz](/u/osolmaz) | 97.2 | 夯 | 290 | 76 |
| [ngutman](/u/ngutman) | 96.0 | 夯 | 91 | 143 |
| [omarshahine](/u/omarshahine) | 93.4 | 夯 | 60 | 57 |

Special mention to [joshavant](/u/joshavant): #7 by commits (558), score 95.7, 160 followers. The gap between engine score and follower count is the recurring theme of this series — the people doing the work are rarely the people being watched.

## Method and limitations

Scores come from ghfind's deterministic rubric — six dimensions over public GitHub data, no model calls, open source under AGPL. Full rubric and thresholds: [methodology](/methodology). Aggregates behind every table: [data.json](/blog/who-builds-openclaw/data.json).

- **Top-100 by commits is the head, not the community.** OpenClaw counts 368 code contributors plus ~2,800 anonymous email identities; farming, if any, would concentrate in that tail, which this study does not cover.
- **Raw commit counts are workflow-dependent.** OpenClaw's direct-commit, agent-driven style produces more commits per unit of work than squash-merge projects like Dify; concentration ratios are comparable within a repo, cross-repo commit totals are not.
- **Point-in-time.** Data collected 2026-07-11 on a project moving faster than any before it. Live data: [OpenClaw project page](/developers/repo/openclaw/openclaw).
- **Farming counts are aggregate-only by policy.** We identify individuals only in positive contexts.

---

*Browse [OpenClaw's live contributor board](/developers/repo/openclaw/openclaw), read the [Dify companion study](/blog/who-builds-dify), or [score your own GitHub account](/) — same engine, 20 seconds.*
