<div align="center">

# ghfind 🔥

### Discover the best developers — and become one.

An evidence-based platform to **find** great developers, **measure** where you stand, and **grow** from there.

Start with a brutally honest **0–100 value & trust score** on any public GitHub profile — see your gaps, learn where to go, then explore the strongest builders in your ecosystem, find worthy peers and rivals, and let your own work get discovered.

**English** · [中文](./README.zh.md)

[**🔍 Score a GitHub profile**](https://ghfind.com/en) · [**🏆 Discover top developers**](https://ghfind.com/en/leaderboard) · [**⭐ View source**](https://github.com/hikariming/ghfind)

</div>

[![ghfind developer profile preview](./show_img/usercard.png)](https://ghfind.com/en/u/hikariming)

## Measure. Grow. Discover.

### 📊 Know exactly where you stand in 30 seconds

Enter a GitHub handle to get a **0–100 value & trust score**, a five-tier verdict (🏆 GOD / 🥇 ELITE / 💪 SOLID / 🫥 NPC / 💩 TRASH), and a brutally honest read grounded in public data. Six scoring dimensions and ten farming red flags separate sustained engineering work from star farming, fork hoarding, bots, and self-merged PRs — so the score tells you what's real and where to improve.

### 🧭 Discover the developers worth knowing

ghfind is a discovery engine, not just a scorer. Use the leaderboard and public profiles to find strong open-source contributors, builders in your ecosystem, potential collaborators, and the developers you want to measure yourself against — and let the right people find you.

[![ghfind developer leaderboard](./show_img/leaderboard.png)](https://ghfind.com/en/leaderboard)

### 🪪 Turn your GitHub work into a shareable identity

Every assessment can generate a live badge and light/dark developer card for your GitHub profile, project README, portfolio, or personal site. Here is a real example:

<div align="center">

[![ghfind score badge](https://ghfind.com/api/badge/hikariming)](https://ghfind.com/en/u/hikariming)

<a href="https://ghfind.com/en/u/hikariming">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ghfind.com/api/card/hikariming?theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://ghfind.com/api/card/hikariming?theme=light">
    <img alt="ghfind card for hikariming" src="https://ghfind.com/api/card/hikariming?theme=light" width="720">
  </picture>
</a>

</div>

The scoring core comes from the open-source Claude skill `github-account-value`. This site **ports its Python scoring logic line-by-line into TypeScript**, with unit tests locking the two outputs in parity.

## How it works

```
browser ─▶ /api/scan ─▶ [Redis cache?] ─▶ lib/github.ts  (GitHub REST + GraphQL, operator PAT)
                                     └─▶ lib/score.ts   (deterministic scoring, parity with the Python skill)
                                     └─▶ write cache 24h
         ─▶ /api/roast (streaming) ─▶ LLM judge pass (bounded score calibration)
                                      └─▶ LLM writer pass (roast/report text only)
                                      └─▶ lib/llm.ts (OpenAI-compatible; defaults to StepFun; bring-your-own key)
```

- **The base score is deterministic** — computed server-side by `lib/score.ts`.
- The LLM runs in two separated passes: a factual judge may apply a bounded **±10** calibration, then a writer turns the fixed result into tags, the top roast line, and the report. The writer cannot change the score.
- 6 dimensions (account maturity / original project quality / contribution quality / ecosystem impact / community influence / activity authenticity) + 10 farming red flags. Weights lean toward **hard-to-fake** signals (PRs merged into real repos, sustained activity) and discount **buyable** ones (stars, followers).
- The site also includes share cards, README badges, profile comments, and GitHub-authenticated profile reactions.

## ghfind API, MCP server & SDKs

Everything on the site is available programmatically — full reference at **[ghfind API documentation](https://ghfind.com/docs)**:

- **REST API** — `GET https://ghfind.com/api/score/{username}` for a deterministic 0–100 score (no auth, no LLM); OpenAPI 3.1 spec at [ghfind.com/openapi.json](https://ghfind.com/openapi.json)
- **MCP server** — Streamable HTTP at [ghfind.com/mcp](https://ghfind.com/mcp); add it to Claude, Cursor, or any MCP client to score and compare GitHub accounts from inside the agent
- **SDKs** — [`@hikariming/ghfind`](https://www.npmjs.com/package/@hikariming/ghfind) (npm) · [`ghfind`](https://pypi.org/project/ghfind/) (PyPI)
- **For AI agents** — [ghfind.com/llms.txt](https://ghfind.com/llms.txt) links every machine-readable surface

## Local development

```bash
pnpm install
cp .env.example .env.local   # set GITHUB_TOKEN and LLM_API_KEY (defaults to StepFun)
pnpm dev
```

> **Always set `GITHUB_TOKEN`.** Without a token, GitHub's GraphQL dimensions (contributions / activity / external contributions) all drop to zero (scores get badly underestimated), and REST is rate-limited to 60/h. A read-only PAT raises the limit to 5000/h and unlocks every dimension.

### Commands

| Command | Description |
|------|------|
| `pnpm dev` | Local development |
| `pnpm start` or `pnpm build/start` | One-command production build + run |
| `pnpm build` / `pnpm start:prod` | Build only / run an existing production build |
| `pnpm ghfind` | Agent-friendly `ghfind` CLI wrapper around the website scoring and discovery APIs |
| `pnpm test` | Vitest test suite (scoring, prompts, DB, UI helpers, reactions, etc.) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |

### Agent CLI

The CLI is a thin remote wrapper around the public website APIs. It does **not**
run GitHub scanning, scoring, or LLM logic locally.

```bash
pnpm ghfind commands --json
pnpm ghfind update check -o json
pnpm ghfind score hikariming -o json
pnpm ghfind roast hikariming --lang en -o markdown
```

For a standalone binary:

```bash
pnpm cli:build
./bin/ghfind commands --json
./bin/ghfind update check -o json
./bin/ghfind roast hikariming --lang en -o markdown
./bin/ghfind leaderboard --view trending --window all -o json
./bin/ghfind developers --type language -o json
```

The CLI name is `ghfind`. The standalone binary is built as `./bin/ghfind`,
and package/bin metadata also exposes `ghfind`.

The default service host is `https://ghfind.com`. Override it for local dev:

```bash
GHFIND_HOST=http://localhost:3000 pnpm ghfind roast hikariming --lang en
```

`GITHUB_ROAST_HOST` is still accepted as a backward-compatible alias.

Production `/api/scan` uses Turnstile for browser calls. For agent/CLI calls,
set `GITHUB_ROAST_CLI_API_KEY` on the server and pass the same value to the CLI
as `GHFIND_API_KEY` or `--api-key`; the CLI sends it as
`Authorization: Bearer ...` to the same `/api/scan` endpoint.
`GITHUB_ROAST_API_KEY` remains a backward-compatible alias.

`/api/scan` checks machine auth or Turnstile before it reads the scan cache or
uses the server GitHub token. If `GITHUB_ROAST_CLI_API_KEY` is not configured
and Turnstile is enabled, an unauthenticated CLI request can fail before cache
lookup, even when the server has a GitHub token and Redis cache.

Version/update management:

```bash
ghfind --version
ghfind update check -o json
ghfind update install --method binary --dry-run -o json
ghfind update install --method binary
ghfind update npm --dry-run -o json
ghfind update npm
ghfind update pip
ghfind update brew
```

`update check` compares the local CLI version with the latest GitHub release and
prints `update_available`, `latest_version`, and `release_url`. It only reports;
it never modifies the installed binary.

`update install --method binary` downloads the current platform's GitHub release
asset, writes it next to the running binary, and replaces the local `ghfind`
binary by rename. Use `--dry-run` first to inspect the selected asset and target
path. Package-manager shortcuts run the matching upgrade command:

- `ghfind update npm`: `npm install -g @hikariming/ghfind@latest`
- `ghfind update pip`: `python3 -m pip install --upgrade ghfind`
- `ghfind update brew`: `brew upgrade ghfind`

These commands modify the local installation only when explicitly invoked. They
are not triggered by `update check`.

Connected website APIs:

- `scan` / `score`: `POST /api/scan`, factual structured score data.
- `roast`: `POST /api/scan` + `POST /api/roast`, web-facing roast report.
- `stats`: `GET /api/stats`, platform aggregate metadata.
- `leaderboard`: `GET /api/leaderboard`, cached ranking/discovery entries.
- `developers`: `GET /api/developers`, language/org/repo discovery facets.

For agent decisions about one account, use `scan` or `score`; leaderboard and
developer directory commands are discovery/catalog surfaces, not fresh scoring
facts.

## Environment variables

See [`.env.example`](./.env.example). The minimum to run the GitHub roast flow is `GITHUB_TOKEN` + `LLM_API_KEY` (defaults to StepFun, OpenAI-compatible; swap in any OpenAI-compatible service). Cache, rate limiting, human verification, GitHub login, profile comments/reactions, and the leaderboard **degrade silently** when unconfigured in local development. Production requires `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`: when the limiter is unavailable, only protected uncached cost-bearing routes return `503` with `Retry-After`; edge-cached responses and ordinary browsing continue. `RATE_LIMIT_FAIL_OPEN=1` is an emergency operator override and should not be set during normal operation.

## Leaderboard + percentile (Turso, optional)

Configure `TURSO_*` to unlock the "Hall of Fame" leaderboard (`/leaderboard`) and the result page's "🏆 You beat X% of developers".
Each scan upserts the account's latest score into the DB (one row per account); percentile = the share of stored scores strictly below yours.
**The public board only lists accounts scoring ≥60**; lower scores still count toward the percentile but are not publicly named (anti-harassment). The whole feature degrades silently when unconfigured.

```bash
# cloud
turso db create github-roast
turso db tokens create github-roast   # gives TURSO_DATABASE_URL(libsql://...) + TURSO_AUTH_TOKEN
# local dev, no cloud
TURSO_DATABASE_URL=file:./local.db
```

## Deploy to Vercel

1. Push to GitHub, import in Vercel.
2. Configure environment variables (as above). `UPSTASH_*` can be provisioned in one click via Vercel's Upstash integration.
3. Grab a Cloudflare Turnstile site/secret key pair; set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`.
4. (Optional) Turso: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` to enable the leaderboard, archived reports, profile comments/reactions, and resumable public-history scans.
5. For resumable public-history scans in Vercel, set `CRON_SECRET`. The included `vercel.json` invokes the authenticated internal worker every five minutes; Turso is the durable queue and no additional queue SaaS is required. This cadence requires a Vercel plan that permits sub-daily Cron jobs; Vercel Hobby deployments reject the five-minute schedule at deployment time.
6. (Optional) GitHub OAuth: `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` + `AUTH_SECRET` to enable signed-in comments/reactions.
7. (Optional) set `PUBLIC_SITE_URL` when deploying under a custom domain so metadata, sitemap, cards, and LLM attribution use the right origin.
8. Deploy.

## Bring your own model / API key

Click "Use your own model" on the page and enter Base URL + API Key + Model. Compatible with any OpenAI-style API (OpenAI / OpenRouter / Groq / DeepSeek / local). **The key lives only in your own browser's localStorage, is passed directly on call, and is never uploaded to the server or persisted.**

## Regenerating the scoring-parity test baseline

`src/lib/__tests__/score-fixtures.json` is the ground truth produced by the Python skill's `score()`. After the skill formula changes, re-run `score()` from `github-account-value/scripts/fetch_github_profile.py` on the same inputs, overwrite that file, then `pnpm test` to verify the port didn't drift.

## Disclaimer

This site generates scores and commentary automatically from **public GitHub data only**. It roasts an account's public behavior and data, is not directed at individuals, does not constitute a factual finding, and must not be used for harassment. Private contributions are excluded, so active members of private orgs may be underrated.

## Sponsorship & fairness

Sponsorship is welcome to cover running costs (GitHub API, LLM, hosting). Note that:

- **Sponsorship does not affect any score or ranking.** Scores are computed deterministically by `src/lib/score.ts`; sponsors cannot buy a higher score, a better rank, or "whitewashing". Sponsor placements and leaderboard data are physically separated in the product.
- Sponsor perks are attribution/placement only and never touch the scoring logic.

## License

Licensed under **[GNU AGPL-3.0](./LICENSE)**.

- You may freely use, modify, and self-host this project.
- **If you modify it and offer it as a network service** (SaaS / hosted), AGPL requires you to **release your modifications under AGPL as well** (users interacting over the network are entitled to the source).
- The scoring core is ported from the open-source Claude skill `github-account-value`, kept as the single source of truth.

> **Trademark:** the "ghfind / 毒舌 GitHub 评分" name, logo, and domain are **not covered** by the open-source license; all rights reserved. You may self-host from this code, but please do not use the project's name/brand to impersonate the official site or cause confusion.

## Star History

<a href="https://www.star-history.com/?repos=hikariming%2Fghfind&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=hikariming/ghfind&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=hikariming/ghfind&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=hikariming/ghfind&type=date&legend=top-left" />
 </picture>
</a>
