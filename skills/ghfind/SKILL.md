# ghfind CLI

Use this skill when an agent needs to score or roast a public GitHub account
through the official ghfind service.

The CLI is a remote wrapper around the website API. It does not run local
GitHub scanning, scoring, or LLM logic. Use it instead of importing project
internals.

The CLI command name is `ghfind`.

## Default Service

The default host is:

```bash
https://ghfind.com
```

Override it for local development:

```bash
GHFIND_HOST=http://localhost:3000
```

`GITHUB_ROAST_HOST` is still accepted as a backward-compatible alias.

## Authentication

Production `/api/scan` requests need either a machine API key or a Turnstile
token. Prefer machine auth for agents:

```bash
GHFIND_API_KEY=...
```

This is sent as:

```text
Authorization: Bearer <key>
```

Deployments should set `GITHUB_ROAST_CLI_API_KEY` on the server. Agents pass the
same value as `GHFIND_API_KEY` or `--api-key`. `/api/scan` checks machine
auth or Turnstile before it reads the scan cache or uses the server GitHub token.
When Turnstile is enabled, an unauthenticated CLI request can fail before cache
lookup, even if the server has a GitHub token and Redis cache.

`GITHUB_ROAST_API_KEY` and `GITHUB_ROAST_TURNSTILE_TOKEN` remain compatibility
aliases for older automation.

The server still uses the same website endpoints:

```text
POST /api/scan
POST /api/roast
```

Do not call `/api/cli/*`; no separate CLI API exists.

## Discovery

Start by discovering commands:

```bash
pnpm ghfind commands --json
pnpm ghfind commands show roast --json
pnpm ghfind update check -o json
```

When a standalone binary is available, prefer it:

```bash
./bin/ghfind commands --json
./bin/ghfind commands show roast --json
./bin/ghfind update check -o json
```

`update check` compares the local CLI version with the latest GitHub release and
returns `update_available`, `latest_version`, and `release_url`. It only reports;
it never modifies the installed binary.

## Common Calls

Platform overview and discovery:

```bash
./bin/ghfind stats -o json
./bin/ghfind leaderboard --view trending --window all -o json
./bin/ghfind developers --type language -o json
./bin/ghfind developers --type org --value apache -o json
```

Scan a user and return raw website scan JSON:

```bash
pnpm ghfind scan <username> -o json
```

Return only the deterministic scoring summary:

```bash
pnpm ghfind score <username> -o json
```

Generate a full report:

```bash
pnpm ghfind roast <username> --lang zh -o json
pnpm ghfind roast <username> --lang en -o markdown
```

Equivalent standalone binary calls:

```bash
./bin/ghfind scan <username> -o json
./bin/ghfind score <username> -o json
./bin/ghfind roast <username> --lang zh -o json
```

Check local CLI credentials:

```bash
pnpm ghfind auth status -o json
```

## Response Semantics

`scan` calls `POST /api/scan` and returns factual structured data:

- GitHub profile metrics.
- Repository, PR, impact, pinned repo, and organization signals.
- Deterministic `scoring.sub_scores`, `red_flags`, `tier`, and base
  `final_score`.
- No writer-layer roast copy.

`score` is a compact factual summary derived from `scan.scoring`.

`stats`, `leaderboard`, and `developers` are platform discovery commands:

- `stats` returns aggregate platform metadata such as total scored accounts.
- `leaderboard` returns cached public ranking/discovery entries.
- `developers` returns cached facet categories or developer buckets.

These discovery commands help agents find candidates or understand public
ranking context. They are not fresh factual scoring sources for an individual
developer. Before making claims about one account, call `scan` or `score`.

`roast` calls `POST /api/scan` and then `POST /api/roast`. It returns the same
web-facing report a human sees:

- `meta.final_score`, `tier`, `tier_label`, `delta`, `percentile`.
- `tags` and `roast_line`.
- Markdown report text with writer-layer style, jokes, sarcasm, and roast copy.

For automated factual decisions, use `scan` or `score`. Use `roast` only when
the agent needs the user-facing report text. Do not treat roast prose as
independent factual evidence.

## Agent Rules

- Prefer `-o json` for machine consumption.
- Use `--host http://localhost:3000` when testing an active local dev server.
- Do not pass GitHub tokens or LLM API keys to the CLI; those belong on the
  server.
- Do not reimplement scoring locally.
- Use `scan` / `score` for objective scoring and `roast` for presentation copy.
- The authoritative factual score input comes from `POST /api/scan`; the
  user-facing report comes from `POST /api/roast`.
