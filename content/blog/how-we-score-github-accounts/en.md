---
title: "How We Score a GitHub Account, in Plain English"
description: "A no-jargon walkthrough of the open-source engine behind ghfind: the six things it measures, why merged PRs count far more than stars, the bot patterns it penalizes, and how to run the whole scorer yourself."
date: "2026-07-13"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**In one sentence:** the score answers a single practical question — *is this GitHub account a real, valuable developer, or something inflated to look like one?* — and it answers it the same way every time, using only public data, with all the rules published in the open. This post explains, without the jargon, exactly how the number is built.

## Why a score at all

More and more decisions lean on a glance at someone's GitHub. A recruiter skims a profile before a call. A maintainer decides whether a stranger's pull request is worth reviewing. A directory ranks accounts by how impressive they look. Every one of those uses creates a reason to *fake* the signals — and faking is easy for the cheap ones. Stars can be bought. Followers can be traded. You can open a hundred one-line pull requests in an afternoon and call yourself an "open-source contributor."

So a useful score can't just add up the big, shiny numbers. It has to lean on the things that are genuinely hard to fake, and shrug off the things that aren't. That single idea drives every design choice below.

## The one principle: weight what's hard to fake

Split every GitHub signal into two buckets.

- **Cheap to fake:** stars, followers. A few dollars or a follow-for-follow ring produces them.
- **Expensive to fake:** merged pull requests into real projects that someone *else* maintains, years of steady activity, code that a busy maintainer actually accepted.

The engine weights the second bucket heavily and the first bucket lightly. Stars and followers still count — a genuinely popular project *should* help you — but they're capped low enough that buying them barely moves the needle. Meanwhile, getting real code merged into a well-known repo, which requires convincing a human who has no reason to help you, is worth the most points on the board.

That's the whole philosophy. The rest is just how it's spread across six categories.

## The six things it measures

The score runs from 0 to 100, divided across six dimensions. Here's each one in plain terms, with its maximum points.

| Dimension | Max | What it's really asking |
|---|---|---|
| **Contribution quality** | 27 | Do you get real pull requests merged into real projects, and do maintainers accept them? |
| **Ecosystem impact** | 20 | Has your code landed in genuinely popular repositories — ones you don't own? |
| **Original project quality** | 18 | Have you built something people actually use (measured by stars, but capped)? |
| **Activity authenticity** | 17 | Are you steadily active over time, in varied ways — or was it one burst and then silence? |
| **Account maturity** | 10 | How long has this account existed and stayed active? |
| **Community influence** | 8 | Do you have a real following, with a healthy ratio? |

![Where the 100 points go, by dimension](/blog/how-we-score-github-accounts/weight-breakdown.svg "The six dimensions and their maximum points. Orange = hard-to-fake signals; gray = buyable ones.")

Notice the two biggest slices — contribution quality (27) and ecosystem impact (20) — are exactly the hard-to-fake ones. Stars (18) and followers (8), the buyable ones, together are worth less than merged pull requests alone. That ordering is the point.

### The signal that matters most: whose code, in whose repo

The single most important number is **ecosystem impact** (20 points), and it's worth explaining why, because it's the cleverest part.

It counts substantial pull requests — more than five lines, not typo fixes — that got merged into **popular repositories you do not own**. Think of a developer whose real work lives inside a famous project's codebase rather than in their own starred repos. You cannot fake this. Merging a real change into a 50,000-star project means a maintainer with no incentive to help you looked at your code and said yes. That's the closest thing GitHub has to a peer-reviewed credential.

There's one deliberate exception. If the popular repo is your *own* — but genuinely popular, at 1,000 stars or more — that still counts, because it captures the creator who spends their time building their own famous project rather than contributing to others'. What does **not** count is pull requests into your own tiny repos. Opening PRs against a project you made yesterday that nobody stars is the classic way to inflate a contribution count, so those are excluded here (and penalized elsewhere).

## Why big numbers don't run away with it

A naive score would let one viral repo, or one account with 100,000 followers, dominate everything. This one doesn't, and the reason is a single design choice: every "how much" number is put through a **diminishing-returns curve** before it becomes points.

![Diminishing-returns curve: points earned vs. stars](/blog/how-we-score-github-accounts/diminishing-returns.svg "Points climb fast up to a few thousand stars, then flatten — so a mega-repo or bought stars can't dominate.")

In plain terms: going from 0 to 1,000 stars earns you a lot of points. Going from 50,000 to 51,000 earns you almost nothing — you were already near the top. The curve rewards clearing a meaningful bar without letting a handful of mega-numbers crowd out everything else. A solid developer with a few thousand stars and a steady history isn't buried under one person's single viral repository. It also means star-buying has sharply diminishing value: the first bought stars do little, and buying your way up the curve gets expensive fast for almost no return.

## The red flags: catching the fakes

On top of the six positive dimensions, the engine subtracts points for specific, well-known cheating and low-effort patterns. These are the signatures of bots, spam, and farmed accounts. A few of the main ones, in plain language:

- **Templated PR flooding** — dozens of near-identical, auto-generated pull requests, usually aimed at the same repo. This is the strongest tell of a farmed contribution history.
- **Trivial PR farming** — a pile of one-line "fix typo" pull requests padding out a contribution count with no real work.
- **Self-PR farming** — opening and merging your own pull requests into your own no-star repos to inflate the numbers. Merging your own code proves nothing.
- **Follow farming** — following thousands of accounts to bait follow-backs, leaving a lopsided follower/following ratio.
- **Mass repos on a brand-new account** — an account created last month with fifty repositories is almost never a real developer.
- **Ghost profile** — no bio, almost no followers, no stars, barely any merged work. Not malicious, just empty.
- **Possible star inflation** — a repo with lots of stars but almost no forks or issues, which is what bought stars look like.

The penalties stack, up to a limit, so an account that trips several of these lands near the bottom no matter how good its raw numbers look. Crucially, these patterns live at the level of an account's *history*, not any single action — a lone one-line PR is completely normal; a hundred of them aimed at one repo is not.

## What the final number means

Add up the six dimensions, subtract the red flags, and you land in one of four tiers:

| Score | Tier | Meaning |
|---|---|---|
| 90–100 | **夯 (Solid)** | Top-tier developer — high value, high trust. |
| 70–89 | **人上人 (Standout)** | Quality contributor — worth trusting. |
| 40–69 | **NPC** | Ordinary account — unremarkable or unclear signals. |
| 0–39 | **拉完了 (Cooked)** | Low value — likely inactive, empty, or farmed. |

The tier names are deliberately a bit playful — this started as a roast tool — but the bands behind them are the same deterministic math for everyone.

## An honest note on what the score is *not*

- **It only sees public activity.** Someone who does excellent work in a private company repo can look thin here. A low score is a statement about the *public* footprint, not a verdict on the person.
- **It's a starting point, not a judge.** The number is meant to help a human prioritize — which stranger's PR to look at first, which profile deserves a closer read — not to auto-reject anyone. The evidence behind the score matters more than the score.
- **Recent behavior counts more than ancient history.** The ecosystem-impact signal looks at recent pull requests, so someone whose big contributions were all years ago will score lower than their résumé suggests. That's intentional: it measures what you're doing *now*.

## It's open source — run it yourself

None of this is a black box, and that's the point. There is no model in the loop, no hidden weighting, no "trust us." The same input always produces the same score, and every rule described above — every weight, every threshold, every red-flag trigger — is published under the AGPL license.

- **Read the code:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind)
- **Install the engine:** `npm install ghfind` or `pip install ghfind`
- **Run it locally** with your own GitHub token — nothing leaves your machine — or call the public API ([OpenAPI spec](https://ghfind.com/openapi.json)).
- **Score a single account** in your browser at [ghfind.com](https://ghfind.com).

If you disagree with a weight or a threshold, you can read exactly what it is, change it, and see the effect. A trust score people can't inspect isn't worth much — so we made this one you can.
