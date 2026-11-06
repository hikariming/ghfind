# ghfind CLI

The standalone Go CLI (`cmd/ghfind`, `internal/agentcli`) is a thin client for the
public ghfind APIs. It does not collect GitHub data, score or call an LLM locally.
The npm and PyPI SDKs ship their own `ghfind` command with the same commands plus
offline verification (`scan --verify`, `verify <scan.json>`); see
[`packages/ghfind-js`](../../packages/ghfind-js/README.md) and
[`packages/ghfind-py`](../../packages/ghfind-py/README.md).

## Build and run

Requires Go 1.23+. From the root of this repository:

```bash
go build -o bin/ghfind ./cmd/ghfind  # → ./bin/ghfind (the assembled workspace also has `pnpm cli:build`)
go test ./internal/agentcli
./bin/ghfind commands --json         # self-describing capability catalog
./bin/ghfind score hikariming -o json
./bin/ghfind roast hikariming --lang en -o markdown
./bin/ghfind leaderboard --view trending --window all -o json
./bin/ghfind developers --type language -o json
```

| Command | Endpoint | Notes |
| --- | --- | --- |
| `score`, `scan` | `GET /api/score/{u}`, `POST /api/scan` | Structured score facts. Use these for decisions about one account. |
| `roast` | `POST /api/scan` + `POST /api/roast` | Human-facing report; the AI never changes the score. |
| `leaderboard`, `developers` | `GET /api/leaderboard`, `GET /api/developers` | Discovery surfaces, not fresh scoring facts. |
| `stats` | `GET /api/stats` | Platform totals. |
| `bot …` | ghfind Review API | Manage the GitHub App on repositories you administer (below). |

## Host and credentials

- `GHFIND_HOST` (default `https://ghfind.com`; `GITHUB_ROAST_HOST` still accepted).
  Against a local ghfind (`pnpm dev:local` in the assembled workspace): `GHFIND_HOST=http://127.0.0.1:4390 ./bin/ghfind score <user>`.
- `GHFIND_API_KEY` / `--api-key` is sent as `Authorization: Bearer …`.
  Production `POST /api/scan` requires Turnstile for browsers; machine callers need
  the server's `GITHUB_ROAST_CLI_API_KEY` value (`GITHUB_ROAST_API_KEY` is a
  backward-compatible alias). Auth is checked **before** the scan cache, so an
  unauthenticated CLI scan can fail even when the account is cached.
- `ghfind bot` needs a personal `ghf_` token from
  [Integrations](https://ghfind.com/integrations) created with **Manage the ghfind
  Review bot** selected. Reads require write access to the repository, changes
  require admin. Same-owner renames and App reinstalls keep bot settings; an owner
  transfer resets AI opt-ins, allowed intent labels and custom prompts.

## Updating

```bash
ghfind --version
ghfind update check -o json                        # report only; never modifies anything
ghfind update install --method binary --dry-run    # inspect the asset and target path
ghfind update install --method binary              # download and replace by rename
ghfind update npm | pip | brew                     # run the package manager's upgrade
```

`update check` prints `update_available`, `latest_version` and `release_url`.
Package-manager shortcuts run `npm install -g @hikariming/ghfind@latest`,
`python3 -m pip install --upgrade ghfind` or `brew upgrade ghfind`, and only when
invoked explicitly.
