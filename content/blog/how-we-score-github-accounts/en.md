---
title: "How We Score a GitHub Account, in Plain English"
description: "A no-jargon walkthrough of devscore, the open-source engine behind ghfind: why it weighs real work instead of stars and followers, how it decides what a project is worth and how much of it is yours, the farming patterns it caps, and what the six dimensions on a profile mean."
date: "2026-07-13"
updated: "2026-09-28"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**In one sentence:** the score answers a single practical question — *how much real, valuable work has this developer done in public?* — and it answers it the same way every time, using only public data, with every rule published in the open. This post explains, without the jargon, how the number is built.

## Why a score at all

More and more decisions lean on a glance at someone's GitHub. A recruiter skims a profile before a call. A maintainer decides whether a stranger's pull request is worth reviewing. A directory ranks accounts by how impressive they look. Every one of those uses creates a reason to *fake* the signals — and the popular signals are the easiest to fake. Stars can be bought. Followers can be traded. You can open a hundred one-line pull requests in an afternoon and call yourself an "open-source contributor."

So a useful score can't add up the big, shiny numbers. It has to measure the work itself, and ignore the numbers that can be bought. That single idea drives every design choice below.

## The one principle: weigh the work, not the applause

The engine behind the score is called **devscore**. Its rule is short: *score what a developer actually built, weighted by how much it matters and how much of it is theirs.*

- **Stars and followers never count.** Not a little, not capped — zero. They measure attention, and attention is cheap to buy.
- **Pull-request counts don't count either.** The engine measures the commits you wrote and what they changed, so a hundred one-line PRs are still a hundred one-line changes.
- **What counts is code that landed in projects people use.** Your own projects count when other people use them; your work in other people's projects counts when an independent maintainer accepted it.

## What a project is worth

For each repository, devscore first asks how much the project matters. It never looks at stars. It looks at signals that are hard to fake because they require other people to *do* something:

- **other contributors** who wrote code in it,
- **downstream dependents** — packages that depend on it,
- **outside issue authors** — people who use it enough to report problems,
- **forks**, discounted because they are the cheapest of these to farm.

Each tenfold step of adoption adds the same amount, so a kernel with thousands of contributors stands well above a library with twenty, while a project used only by its author and a few friends stays near the floor. A project nobody else uses keeps only a small part of the work done in it — building something for yourself is fine, but it isn't yet something others depend on.

Projects that are all stars and no users get special treatment. A **hype project** — many stars, but almost no contributors, issue authors or dependents, or a sudden promotional spike followed by silence — earns no project credit at all.

## How much of it is yours

Next, devscore asks how much of that project's work is yours. It combines your share of the commits with your standing next to the lead author, so a co-lead of a big project counts as an author even at a modest share, while a distant contributor behind a dominant lead does not. Thousands of your own commits count as authorship whatever the project's size.

Then it measures the work itself: how many commits you landed, what they changed (core code counts more than docs or chores; a large change a maintainer accepted counts more than a tiny one), and how many months the work lasted. Commit histories that look machine-generated — every commit at the same hour, every change the same shape — are discounted.

## Other people's projects: only accepted work counts

Work in someone else's repository is the closest thing GitHub has to a peer review — but only if someone independent actually reviewed it. So devscore counts external work **only as far as an independent maintainer accepted it**:

- a PR merged by the project's lead author counts in full;
- one waved through by someone who wrote none of the code counts half;
- a PR you merged yourself, or one merged by a trading partner who merges yours in return, counts nothing;
- dozens of large standalone PRs merged in a batch during a reward campaign are discounted.

Reviewing and merging other people's code is real work too. A **maintainer** — verified by GitHub's own record of your role in that repository, never self-declared — gets credit for that work, and code reviews you give in other people's projects count as well.

## Time: sustained years, not bursts

Finally, devscore rewards doing this for years. It counts **sustained coding years**: each calendar year counts once, capped at twelve months of coding, so spreading one year across sixty small repositories is still one year. Older work fades with a three-year half-life (down to a floor, so a long career is never erased).

All of this is combined into one smooth curve from 0 to 100, with room at the top so the very best separate instead of tying at 100. The strongest role wins: someone is judged both as a developer and as a maintainer, and the better of the two counts.

## Catching the fakes

Most farming never needs a penalty, because the signals it produces — stars, followers, PR counts, self-merges — already score nothing. Two patterns get an explicit **cap**, applied last:

- **Bulk low-quality PRs.** In the worst twelve months, many PRs to other people's projects were rejected or withdrawn — at least as many as were independently merged — together with at least two of: templated titles, duplicate submissions, one-week sprees across many repositories, or giant PRs of thousands of lines.
- **The influencer pattern.** Hundreds of followers, far out of proportion to the engineering other people accepted, with no maintained project and no substantial project of their own.

A capped score is squeezed into the 20–35 range, still ordered by the underlying work. Crucially, both caps fire on a *pattern* across a history — a single rejected PR, or a popular account that also ships real code, is completely normal.

## The six numbers on a profile

The total is devscore's score. To make it readable, each profile also shows six **display dimensions** derived from devscore's factors. They explain the score; they are not added up to make it.

| Dimension | Max | What it shows |
|---|---|---|
| **Contribution quality** | 27 | Independently accepted work in other people's projects, plus code reviews you give there |
| **Ecosystem impact** | 20 | The weight of your work across repositories, or a verified maintainer role — whichever is higher |
| **Original project quality** | 18 | Your flagship: the strongest engineering project you own or lead |
| **Activity authenticity** | 17 | How much of your work is recent; cut sharply when a farming cap applies |
| **Account maturity** | 10 | Sustained years of coding |
| **Community influence** | 8 | How often maintainers merge rather than reject your PRs, plus reviews given — never followers |

## What the final number means

| Score | Tier | Meaning |
|---|---|---|
| 90–100 | **夯 (God)** | Legendary — hall-of-fame work. |
| 80–89 | **顶级 (Elite)** | Top-tier developer. |
| 70–79 | **人上人 (Solid)** | Quality contributor — worth trusting. |
| 40–69 | **NPC** | Ordinary account — unremarkable or unclear signals. |
| 0–39 | **拉完了 (Trash)** | Little public work — or a capped farming pattern. |

The tier names are deliberately a bit playful — this started as a roast tool — but the math behind them is the same for everyone.

## An honest note on what the score is *not*

- **It only sees public activity.** Someone who does excellent work in private company repositories can look thin here. A low score is a statement about the *public* footprint, not a verdict on the person. Each score carries a confidence level that says how much public evidence it rests on.
- **It's a starting point, not a judge.** The number is meant to help a human prioritize — which stranger's PR to look at first, which profile deserves a closer read — not to auto-reject anyone. The evidence behind the score matters more than the score.
- **Old work fades, slowly.** Recent years count more than ancient history, but a long track record is never wiped out.

## It's open source — run it yourself

None of this is a black box. There is no model in the loop and no hidden weighting: the same public data always produces the same score, and every rule described above — every weight, every threshold, every cap — is published under the AGPL license.

- **Read the code:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind) (the engine lives in `src/lib/devscore`)
- **Run it locally** with `npx @hikariming/ghfind score <user> --local` and your own GitHub token — nothing leaves your machine — or call the public API ([OpenAPI spec](https://ghfind.com/openapi.json)).
- **Score a single account** in your browser at [ghfind.com](https://ghfind.com).

If you disagree with a weight or a threshold, you can read exactly what it is, change it, and see the effect. A trust score people can't inspect isn't worth much — so we made this one you can.
