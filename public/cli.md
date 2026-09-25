# ghfind CLI

The official command-line client for ghfind.com. Install it with Node.js 18 or newer:

```sh
npm install --global @hikariming/ghfind
```

Or install the CLI and Agent Skill together:

```sh
curl -fsSL https://ghfind.com/install.sh | bash
```

## Authentication

Public commands such as `score`, `vs`, `search`, `leaderboard`, and `developers` do not need a token. `scan` and `roast` use the protected scan API and need a personal API token in production. Sign in to [ghfind.com](https://ghfind.com/integrations) with GitHub, create a token, then set `GHFIND_API_KEY` or pass `--api-key`.

```sh
export GHFIND_API_KEY=ghf_your_token
ghfind scan torvalds -o json
ghfind roast torvalds --lang zh -o markdown
```

Website GitHub sign-in establishes a browser session. A CLI request uses a personal bearer token created from that signed-in account; the browser session cookie is not a CLI credential. Revoke tokens at [ghfind.com/integrations](https://ghfind.com/integrations).

## Agent Skill

Install the `ghfind-cli` Skill from [ghfind.com/skill](https://ghfind.com/skill) or run the combined installer above. The Skill teaches compatible coding agents the available commands and when public results versus authenticated scans are appropriate.

Full reference: [ghfind.com/docs](https://ghfind.com/docs) · [OpenAPI](https://ghfind.com/openapi.json) · [MCP](https://ghfind.com/mcp)
