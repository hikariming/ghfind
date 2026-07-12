---
title: "382,000 Stars, One Pair of Hands: Who Actually Builds OpenClaw?"
description: "OpenClaw became the fastest-growing repository in GitHub history. We scored its top 100 contributors with a deterministic engine: one person wrote 57% of the commits, zero contributors show signs of faked activity, and a fifth of them joined GitHub less than a year ago."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Key findings** (data collected 2026-07-11, top 100 committers of [openclaw/openclaw](https://github.com/openclaw/openclaw), scored with the open-source [ghfind engine](/methodology)):

- **The fastest-growing repository in GitHub history is, measured by commits, mostly one person.** Creator [steipete](/u/steipete) wrote 33,482 of the top sample's 58,487 commits — **57.2%**. The top three contributors account for 81.5%, the top ten for 90.2%.
- **Zero faked activity.** Not one of the 96 human top-100 contributors shows the manufactured-contribution pattern our engine flags — a pattern that appears in 0.58% of accounts even in our carefully filtered 18,947-account baseline. The hype is enormous; the people behind it are real.
- **The AI-agent boom is pulling newcomers into open source.** 19.6% of top contributors have GitHub accounts less than a year old (at Dify, an older project of comparable fame, it's 4.7%). Some are already excellent: the #3 committer runs a 2.3-year-old account that scores 94.1.

## Why OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) needs little introduction: created on 2025-11-24 by Peter Steinberger ([steipete](/u/steipete), founder of PSPDFKit), renamed twice in a single week of January 2026 (Clawdbot → Moltbot → OpenClaw), and the fastest project ever to reach 100,000 GitHub stars. As of 2026-07-11 it stands at **382,580 stars, 80,292 forks, and 368 code contributors** — about seven and a half months after the first commit.

A star curve like that is exactly what our engine was built for: when a number climbs that fast, is there anything real underneath? We took the top 100 contributors by commit count, excluded 4 bots (including the project's own `clawsweeper` and `openclaw-clownfish`), and scored all 96 humans. 92 have full raw-metric snapshots.

## Contributor quality: the top of the list is excellent

| | OpenClaw top-100 | Dify top-100 | 19k baseline |
|---|---|---|---|
| Median score | **79.7** | 78.2 | 42.5 |
| Score ≥ 90 (夯 tier) | **21.9%** | 15.6% | 3.7% |
| Score ≥ 70 (trusted) | **69.8%** | 70.8% | 20.1% |
| Score < 40 (low-value) | **9.4%** | 5.2% | 48.6% |

(The Dify column comes from [our companion study](/blog/who-builds-dify), scored the same week with the same engine.)

One in five of OpenClaw's top contributors scores 90 or above; across GitHub at large, only about one account in twenty-seven does. When a project has the whole industry's attention, excellent developers show up to build it. But look at the other end too: 9.4% score below 40, nearly double Dify's rate. All that attention also pulls in brand-new accounts with hardly anything on them — the section on account ages below explains where they come from.

## One pair of hands

Total commits across the top-100 sample: 58,487 — seven times Dify's 8,434, produced in a fifth of the calendar time.

| Share of commits | OpenClaw | Dify |
|---|---|---|
| Most active contributor | **57.2%** | 8.4% |
| Top 3 | **81.5%** | 21.0% |
| Top 5 | **86.0%** | 31.3% |
| Top 10 | **90.2%** | 49.8% |

[steipete](/u/steipete)'s 33,482 commits over 229 days work out to **146 commits per day**. No one types that fast — but someone directing a fleet of coding agents and reviewing what they produce can merge that fast, and that is exactly how OpenClaw is famously built. The engine gives the account a **100/100**: a 17-year GitHub history, 52,067 followers, 2,772 merged PRs — as far from a fake account as it gets. The output is real. It is simply concentrated in one pair of hands to a degree no project this size has ever shown.

The next tier down is small but serious: [vincentkoc](/u/vincentkoc) (10,502 commits, score 96.5), [shakkernerd](/u/shakkernerd) (3,688, score 94.1), [obviyus](/u/obviyus) (1,771, score 93.2). Below the tenth spot, nobody accounts for even half a percent of the commits.

Both ways of building work: Dify is written by a genuinely broad community; OpenClaw is one person making every decision and moving faster than any project before it. But the risks are different — if that one person stops, everything stops — and a star count of 148k versus 382k tells you nothing about which risk you're taking on.

## No faked activity — and why that's still worth saying

Across all 96 humans: **zero** accounts at or above the engine's threshold for manufactured contributions, whether we use the stored scores or recompute with the current engine. Warning signals appear on 19 of 92 accounts (20.7%), but every one of them is of the "thin profile" or "many rejected PRs" variety — `mostly_forks` (15), `no_original_work` (10), `high_pr_rejection` (4). None show mass-produced PR titles; none show a history padded with trivial PRs. For comparison, even Dify's top-100 contains two such accounts, and the baseline rate is 0.58%.

One honest caveat: ranking by commit count naturally keeps fakers out of this sample. Their signature move is one or two trivial PRs per repository, and OpenClaw's #100 contributor has 24 commits — you can't get here on typo fixes. If faked activity exists around OpenClaw, it lives in the long tail of 368 contributors and the [2,800+ anonymous email identities](https://github.com/openclaw/openclaw/graphs/contributors) beyond them, which this study doesn't cover. What the result does rule out is a more serious accusation: that OpenClaw's astonishing numbers were propped up by an army of fake accounts. They weren't. The people at the top of this project check out, one by one.

## The newcomer wave

Account age is where OpenClaw stops resembling Dify entirely:

| | OpenClaw | Dify |
|---|---|---|
| Accounts < 1 year old | **19.6%** | 4.7% |
| Accounts < 2 years old | **26.1%** | 9.3% |
| Median account age | 8.7 years | 9.0 years |

The contributors fall into two distinct groups: a veteran core that joined GitHub around 2017, and a fifth whose accounts barely existed a year ago. These newcomers were pulled into open source by the AI-agent boom — and they are not just passing through. The standout is [shakkernerd](/u/shakkernerd): a 2.3-year-old account, 362 followers, and the #3 commit slot on the biggest repository of the year, scoring 94.1. The low scorers (9.4% under 40 points) are the other side of the same wave: brand-new accounts whose first open-source activity ever is a small OpenClaw fix. A year from now they'll either have built real histories or gone quiet — we'll re-run the numbers and find out.

## The underrated five

Top-tier scores, tiny followings — the OpenClaw regulars nobody is watching:

| Contributor | Score | Tier | Followers | Commits here |
|---|---|---|---|---|
| [RomneyDa](/u/RomneyDa) | 98.4 | 夯 | 169 | 290 |
| [altaywtf](/u/altaywtf) | 97.7 | 夯 | 273 | 66 |
| [osolmaz](/u/osolmaz) | 97.2 | 夯 | 290 | 76 |
| [ngutman](/u/ngutman) | 96.0 | 夯 | 91 | 143 |
| [omarshahine](/u/omarshahine) | 93.4 | 夯 | 60 | 57 |

Special mention to [joshavant](/u/joshavant): #7 by commits (558), score 95.7, 160 followers. The gap between what people contribute and how many people watch them is the running theme of this series — the ones doing the work are rarely the ones being followed.

## Method and limitations

Scores come from ghfind's deterministic rubric — six dimensions over public GitHub data, no model calls, open source under AGPL. Full rubric and thresholds: [methodology](/methodology). The aggregates behind every table: [data.json](/blog/who-builds-openclaw/data.json).

- **Top-100 by commits is the head of the project, not the whole community.** OpenClaw counts 368 code contributors plus ~2,800 anonymous email identities; if faked activity exists, it would sit in that tail, which we didn't score.
- **Raw commit counts depend on workflow.** OpenClaw's agent-driven, commit-directly style produces far more commits for the same amount of work than a squash-and-merge project like Dify. Percentages within one repository are meaningful; comparing raw commit totals across repositories is not.
- **This is a snapshot.** Data collected 2026-07-11, on a project moving faster than any before it. Live data: [OpenClaw project page](/developers/repo/openclaw/openclaw).
- **Fake-activity findings are reported in aggregate only.** We name individuals only when the news is good.

---

*Browse [OpenClaw's live contributor board](/developers/repo/openclaw/openclaw), read the [Dify companion study](/blog/who-builds-dify), or [score your own GitHub account](/) — same engine, 20 seconds.*
