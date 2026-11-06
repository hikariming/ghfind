# Contributing to ghfind

Thanks for helping. This public repository accepts contributions to:

- the **scoring module** (`scoring/`: formula, risk rules, rating ladder, fixtures),
- the **SDKs** (`packages/ghfind-js`, `packages/ghfind-py`),
- the **Go CLI** (`cmd/ghfind`, `internal/agentcli`) and agent skills (`skills/`),
- the public docs (`README*.md`, `docs/`).

The ghfind web application, API and infrastructure live in private repositories
(`FindAny/ghfind-server`, `FindAny/ghfind-frontend`). Report product bugs and ideas
as issues here; maintainers carry them over. The workflows in `.github/` deploy
production and are maintained by the core team (see [AGENTS.md](AGENTS.md)).

## Setup

Node.js 22, pnpm 11.24.0 (pinned in `package.json`), Go 1.23+ and Python 3.9+.

```sh
pnpm install --frozen-lockfile
```

## Checks before a pull request

```sh
pnpm --filter @ghfind/scoring typecheck && pnpm --filter @ghfind/scoring test
pnpm scoring:boundary
(cd scoring && go test ./...)
(cd packages/ghfind-py && python3 -m pytest -q)
(cd packages/ghfind-js && npm ci && npm run typecheck && npm test)
go test ./internal/agentcli
```

Run what your change touches and say which checks you ran. CI runs the scoring
workflow on every pull request; the full application suite runs on maintainers'
branches and before each production release.

## Scoring changes

- Keep `scoring/` pure: no network, environment variables, tokens, timers,
  randomness or imports from outside the module. `pnpm scoring:boundary` enforces it.
- Update the TypeScript reference, the Go port and the Python port together, with
  their fixtures in `scoring/fixtures/`, in the same pull request.
- Explain the effect on real accounts: which dimension moves, by how much, and why
  the new behaviour is fairer. Changes that alter scores ship in a new score version.

Start with a small, focused change, describe the problem it solves and link the
relevant issue.
