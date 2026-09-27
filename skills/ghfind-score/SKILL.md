---
name: ghfind-score
description: Score any GitHub account 0-100 for real contribution value and trustworthiness, detect bot/farmed activity, compare two developers, and discover top developers by language/org/project. Use when asked to vet, rate, or judge a GitHub user, check if an account is real or farmed, or find strong developers. Backed by ghfind.com's deterministic open-source engine via a public no-auth REST API and MCP server.
license: AGPL-3.0-or-later
---

# ghfind — GitHub developer value & trust scoring

ghfind rates any GitHub account from 0 to 100 for real contribution value and
trustworthiness using devscore, a fully deterministic, open-source engine (no
LLM in the scoring core — the same public data always produces the same score).
It weighs real work by project worth and authorship; stars and followers never
count. It also detects
AI/bot/farmed contribution, compares developers head-to-head, and ranks
developers by language, organization, and project.

## When to use this skill

- Vet a GitHub account before hiring, sponsoring, or merging a PR.
- Decide whether an account's activity is genuine or farmed (bulk low-quality
  PR farming, self-merged PRs, followers far out of proportion to real work).
- Get a reproducible, auditable score instead of eyeballing stars/followers.
- Compare two developers, or discover top developers in an ecosystem.

## How to call it (no authentication required)

Deterministic score for one account:

```bash
curl -s https://ghfind.com/api/score/{username}
```

Full evidence payload (metrics, top repos, recent PRs, red flags):

```bash
curl -s -X POST https://ghfind.com/api/scan \
  -H 'Content-Type: application/json' \
  -d '{"username":"{username}"}'
```

Other endpoints: `GET /api/leaderboard`, `GET /api/developers?type=language|org|repo&value=...`,
`GET /api/search-users?q=...`, `POST /api/vs-verdict {"a":"...","b":"..."}`.

Full API contract: https://ghfind.com/openapi.json · Agent docs: https://ghfind.com/llms.txt

## MCP server

Streamable HTTP MCP server at `https://ghfind.com/mcp` exposing the tools
`score_user`, `scan_user`, `compare_users`, `get_leaderboard`, `search_users`.
Server card: https://ghfind.com/.well-known/mcp/server-card.json

## Notes

- The score reflects an account's **public** GitHub footprint only; private-org
  work is invisible to it, so a low score is not a factual claim about a person.
- Scoring is deterministic; only the optional roast text is LLM-written.
- Engine is open source (AGPL): https://github.com/hikariming/ghfind
