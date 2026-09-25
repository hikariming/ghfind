---
name: ghfind-cli
description: >
  Drive the ghfind CLI to score, scan, roast, and compare GitHub accounts and to
  browse ghfind.com leaderboards and developer directories from the terminal.
  Use when the ghfind CLI is installed (or the user wants it installed) and asks
  to vet, rate, roast, or compare a GitHub user, check if an account is farmed,
  generate a score badge, or discover developers by language/org/repo. For
  no-install REST/MCP access to the same engine, prefer the ghfind-score skill.
license: AGPL-3.0-or-later
---

# ghfind CLI

`ghfind` is a thin client for ghfind.com's deterministic GitHub developer
value & trust scoring engine (0-100, no LLM in the scoring core). It performs
no local scanning or scoring — every command calls the website API. Do not
reimplement scoring locally or import project internals.

## Install

Run `curl -fsSL https://ghfind.com/install.sh | bash` to install the official
CLI and this Skill together. The CLI alone can be installed with
`npm install -g @hikariming/ghfind` (Node.js 18+ required).

Prebuilt binaries: https://github.com/hikariming/ghfind/releases

## Configuration

- Default host is `https://ghfind.com`. Override with `GHFIND_HOST` or `--host`
  (e.g. `--host http://localhost:3000` against a local dev server).
- `score`, `vs`, `search`, `exists`, `stats`, `leaderboard`, and `developers`
  are public and unauthenticated. The heavy `POST /api/scan` path used by
  `scan` and `roast` requires a personal API token in production. Sign in at
  https://ghfind.com/integrations with GitHub and create a token; set
  `GHFIND_API_KEY` or pass `--api-key` (sent as `Authorization: Bearer`). A
  browser OAuth session cookie is not a CLI credential.
- Never pass GitHub tokens or LLM API keys to scoring commands; those live on
  the server. Exceptions: `exists --github-token` (raises GitHub's anonymous
  rate limit; the call runs on the caller's quota) and `roast --byo-*` (runs
  the roast through the user's own OpenAI-compatible provider).

## Commands

Prefer `-o json` for machine consumption. Discover the full catalog at runtime:

```bash
ghfind commands --json
ghfind commands show roast --json
```

Score and evidence (factual, deterministic):

```bash
ghfind score <username> -o json     # preferred first call: public GET /api/score,
                                    # cached, scores never-seen accounts live
ghfind scan <username> -o json      # full evidence: metrics, repos, PRs,
                                    # sub_scores, red_flags (needs api key in prod)
```

Presentation and comparison:

```bash
ghfind roast <username> --lang zh -o markdown
ghfind vs <a> <b> -o json
```

Utility and discovery:

```bash
ghfind exists <username> -o json
ghfind search <query> -o json
ghfind badge <username> --markdown
ghfind card <username>
ghfind stats -o json
ghfind leaderboard --view trending --window 7d -o json
ghfind developers --type language -o json
ghfind developers --type org --value apache -o json
ghfind auth status -o json
```

Self-update (only when the user explicitly asks to upgrade; use `--dry-run`
first in automation):

```bash
ghfind update check -o json
ghfind update install --method binary --dry-run -o json
```

## Response semantics

- `score` / `scan` return factual scoring data: `final_score`, `tier`,
  `sub_scores`, `red_flags`, percentile. Use these for automated decisions.
- `roast` returns the same report a human sees on the website: tags,
  `roast_line`, markdown with jokes and sarcasm. Use it only for user-facing
  copy; never treat roast prose as independent factual evidence.
- `vs` winner and gap bucket are deterministic; verdict prose is LLM-written
  and may be null. Both accounts must already be scored (`404 need_both`
  otherwise).
- `stats` / `leaderboard` / `developers` are cached discovery surfaces, not
  fresh per-user facts — before making claims about one account, call `score`
  or `scan`.
- A low score reflects only the account's public GitHub footprint; private-org
  work is invisible to it.
