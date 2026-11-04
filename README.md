<div align="center">

# ghfind 🔥

### Discover the best developers — and become one.

An evidence-based platform to **find** great developers, **measure** where you stand, and **grow** from there.

**English** · [中文](./README.zh.md)

[**🔍 Score a GitHub profile**](https://ghfind.com/en) · [**🏆 Discover developers**](https://ghfind.com/en/leaderboard) · [**🤖 Install the GitHub App**](https://github.com/apps/ghfind-review/installations/new) · [**📚 Docs**](./docs/README.md)

</div>

[![ghfind developer profile](./show_img/usercard.png)](https://ghfind.com/en/u/hikariming)

## What you can do

- **Measure.** Enter a GitHub handle to get a deterministic **0–100 score** across six dimensions, a level and rating, the risk signals behind it, and an optional AI-written report.
- **Discover.** Browse the developer board, language/org/repo directories, project boards and the talent pool, or put two developers head to head.
- **Share.** Every profile has a live README badge and a light/dark developer card.
- **Maintain.** The ghfind Review GitHub App labels new issues and PRs with the author's score band.
- **Integrate.** The same data is available through a REST API, an MCP server, SDKs and a CLI.

[![ghfind developer duel](./show_img/vs.png)](https://ghfind.com/en/vs/torvalds/yyx990803)

## How scoring works

- **Deterministic.** Six dimensions — account maturity, original projects, contribution quality, ecosystem impact, community influence and activity authenticity — plus capped risk rules for farming patterns (star or fork farming, self-merged PRs, PR floods, bots). Same evidence and version, same score.
- **Hard-to-fake signals win.** Merged PRs into real projects and sustained activity weigh more than buyable stars and followers. Only public GitHub data is used, so mostly-private work is underrated.
- **Levels and ratings.** `Lv = floor(score)`. Ratings step every 10 points from 30:

  | Score | < 30 | 30 | 40 | 50 | 60 | 70 | 80 | 90+ |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | Rating | Qi Condensation | Foundation Est. | Core Formation | Nascent Soul | Deity Transformation | Spatial Tempering | Body Integration | Grand Ascension |

- **AI never changes the number.** The report model writes tags and prose from the fixed score.
- **Open and verifiable.** The formula, risk rules and rating ladder are the public module [`scoring/`](./scoring) (TypeScript, Go and a Python port, locked together by shared fixtures). The SDKs (0.2+) recompute any published scan locally: `ghfind verify scan.json`.
- **Super newcomers.** Young accounts with strong, evidenced work can earn up to 4 extra maturity points, fading to zero by age 3 — see [the rule](./docs/scoring/super-newcomer.md).

## Share your profile

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

## GitHub App: ghfind Review

Install **ghfind Review** and new issues and pull requests arrive labelled with the
author's public score band (`review:` labels at 40, 70 and 90; `review: no-score`
when no score is available). By default it doesn't comment, and it never blocks
or closes anything — a profile score is a starting point for triage, not a
verdict on the contribution. Labels are created automatically; no workflow or
secret is needed.

[**Install**](https://github.com/apps/ghfind-review/installations/new) · [English guide](./platform/github-app/README.md) · [中文指南](./platform/github-app/README.zh.md)

## API, MCP and SDKs

Full reference: **[ghfind.com/docs](https://ghfind.com/docs)**.

- **REST** — `GET https://ghfind.com/api/score/{username}` returns a deterministic score with no auth and no LLM. OpenAPI 3.1: [ghfind.com/openapi.json](https://ghfind.com/openapi.json).
- **MCP** — Streamable HTTP at [ghfind.com/mcp](https://ghfind.com/mcp) for Claude, Cursor or any MCP client.
- **SDKs + CLI** — [`@hikariming/ghfind`](https://www.npmjs.com/package/@hikariming/ghfind) (npm) · [`ghfind`](https://pypi.org/project/ghfind/) (PyPI) · the [Go CLI](./docs/development/cli.md).
- **For agents** — [ghfind.com/llms.txt](https://ghfind.com/llms.txt) links every machine-readable surface.

## Repository layout

| Path | What lives there |
| --- | --- |
| [`scoring/`](./scoring) | Public scoring module: formula, risk rules, rating ladder, fixtures (npm `@ghfind/scoring` + Go module) |
| `src/`, `apps/` | Web app: Astro pages (`apps/web`), Hono API (`apps/api`), router and supporting Workers, shared Next code in `src/` |
| `internal/`, `cmd/` | Go: CLI, legacy API and the portable Feed runtime |
| `packages/` | `ghfind-js` and `ghfind-py` SDKs, shared `i18n` |
| `platform/` | GitHub App and Feed platform |
| [`docs/`](./docs/README.md) | Architecture, operations runbooks, contracts and release records |

See the [system overview](./docs/architecture/overview.md) for how these fit together in production.

## Local development

Requires Node 22 (as in CI), pnpm 11 and, for the CLI and Go tests, Go 1.23+.

```bash
pnpm install
cp .env.example .env.local     # set GITHUB_TOKEN at minimum
pnpm run init                  # local D1 schema, synthetic data, signed-in test identities
pnpm dev:local                 # http://127.0.0.1:4390
```

`pnpm dev` runs plain `next dev` against Wrangler's local D1 emulator; it never
touches Cloudflare. Apply the schema once with
`pnpm exec wrangler d1 migrations apply ghfind --local` (and `ghfind-feed-dev`).
See [local accounts](./docs/development/local-accounts.md) for test identities.

**Always set `GITHUB_TOKEN`** (a read-only PAT): without it, GraphQL dimensions
drop to zero and REST is limited to 60 requests/hour. `LLM_API_KEY` is only needed
for operator-funded AI reports. Everything else in [`.env.example`](./.env.example)
(Turnstile, OAuth, Upstash, Mosoo, Feed) enables optional features.

| Command | Purpose |
| --- | --- |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | Vitest suite, TypeScript, ESLint |
| `go test ./...` | Go packages (and `cd scoring && go test ./...` for the public module) |
| `pnpm scoring:boundary` | Keep `scoring/` pure (no network, env, tokens or private imports) |
| `pnpm frontend-stack:check` | Enforce the frontend dependency rules in [`AGENTS.md`](./AGENTS.md) |
| `pnpm cf:build` | Production build for Cloudflare (OpenNext) |
| `pnpm cli:build` | Build `./bin/ghfind` |

Contributors and coding agents: read [`AGENTS.md`](./AGENTS.md) first.

## Deployment

Production runs on Cloudflare Workers and deploys from CI on `hikariming/ghfind`
`main`, with automatic rollback when post-deploy smoke checks fail. Follow the
[Cloudflare deployment runbook](./docs/operations/cloudflare-deployment-runbook.md);
never commit secrets.

## Bring your own model

Choose "Use your own model" on the site and enter a base URL, API key and model
for any OpenAI-compatible provider. The key stays in your browser's localStorage,
is sent only with your request and is never stored on the server.

## Disclaimer

Scores and commentary are generated automatically from **public GitHub data
only**. They describe public activity, are not a judgement of a person, are not
findings of fact and must not be used for harassment.

## Sponsorship and fairness

Sponsorship helps cover GitHub API, LLM and hosting costs. It never affects any
score, rank or risk conclusion — scores come only from the public
[`scoring/`](./scoring) module — and sponsor placements are kept separate from
ranking data.

## License

[GNU AGPL-3.0](./LICENSE). You may use, modify and self-host this project; if you
offer a modified version as a network service, AGPL requires you to publish your
modifications under the same license. The scoring formula began as a port of the
open-source Claude skill `github-account-value` and has since evolved here in
[`scoring/`](./scoring), which is now its source of truth.

> **Trademark:** the "ghfind / 毒舌 GitHub 评分" name, logo and domain are not
> covered by the license. Please don't use them to impersonate the official site.
