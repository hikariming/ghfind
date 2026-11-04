# ghfind (Python)

Official Python SDK **and CLI** for **[ghfind.com](https://ghfind.com)** — score any
GitHub account **0–100** for value and trustworthiness, with roasts, head-to-head
battles, leaderboards, and developer discovery.

- **Deterministic scoring, no LLM.** `scan`, `score`, `get_score`, and the battle
  winner are pure computation over GitHub data.
- **Bring your own model.** The only LLM parts are the *roast prose* and *battle
  commentary*. `roast(..., byo_key=...)` runs the LLM through your own
  OpenAI-compatible provider — or just feed the structured `scan()` output to your
  own model.
- **Verifiable.** The scoring module is open source. `ghfind.local` recomputes
  any scan's score on your machine from its published evidence (see below).
- **Zero dependencies.** Standard library only.

```bash
pip install ghfind
```

---

## CLI

```bash
ghfind score torvalds            # deterministic score (no auth, cached)
ghfind roast torvalds --lang en
ghfind vs torvalds octocat
ghfind badge torvalds --markdown # a README badge that links back to ghfind
```

`score` hits the public **`GET /api/score`** endpoint: no auth, edge-cached and
rate-limited on the server, and it scores never-seen accounts live (still
deterministic, no LLM). It's the cheapest path for you *and* for ghfind.

| Command | What it does | Endpoint | LLM? |
| --- | --- | --- | --- |
| `score <user>` | Deterministic score; prints tier, sub-scores, percentile. | `GET /api/score/{u}` | no |
| `scan <user>` | Full evidence payload (metrics, signals, red flags). Heavy — needs `--api-key` in prod. | `POST /api/scan` | no |
| `verify <file\|->` | Recompute a saved scan's score locally; exit 3 on mismatch. Never touches the network. | — | no |
| `roast <user>` | Human-facing roast report + AI-adjusted score. | `POST /api/scan` + `/api/roast` | yes\* |
| `vs <a> <b>` | Head-to-head verdict (winner deterministic). | `POST /api/vs-verdict` | yes\* |
| `exists <user>` | Does this GitHub login exist? Runs on **your** IP, never touches ghfind. | `api.github.com` | no |
| `search <query>` | Prefix autocomplete over scored accounts. | `GET /api/search-users` | no |
| `leaderboard` | Ranked profiles. `--view` / `--window`. | `GET /api/leaderboard` | no |
| `developers --type language\|org\|repo` | Discover developers by facet. | `GET /api/developers` | no |
| `stats` | Platform totals. | `GET /api/stats` | no |
| `badge <user>` | Badge URL, or `--markdown` for a README snippet linking to the profile. | — | no |
| `card <user>` | OG share-card PNG URL. | — | no |
| `commands [show <c>]` | Self-describing capability catalog (for agents). | — | no |
| `auth status` | Show host + which credentials are configured. | — | no |
| `bot <command> <owner/repo>` | Manage the ghfind Review GitHub App on repos you administer (see below). | `bot.ghfind.com/api/v1` | no |

`*` `roast`/`vs` prose is the only LLM part. Pass `--byo-base-url --byo-api-key
--byo-model` (or `GHFIND_BYO_*` env vars) to run `roast` through your own model
instead of ghfind's.

### Verify a score locally

Every score is a pure function of its published evidence. `--verify` re-scores a
scan with the open-source scoring module (the Python port of `@ghfind/scoring`, pinned by shared parity fixtures) —
no GitHub calls, no token — and exits `3` if anything differs:

```bash
ghfind scan torvalds --verify          # fetch the scan, recompute it locally
ghfind scan torvalds --json > s.json
ghfind verify s.json                   # offline, any time later (or: ghfind verify -)
```

> **0.2.0:** `--local` (crawl + score on your own token) was removed. GitHub
> collection now runs only on the ghfind service, which rate-limits and schedules
> it; the scoring itself stays open and verifiable as shown above.

### Options & environment

```
--host <url>          default https://ghfind.com (or GHFIND_HOST)
--api-key <key>       Authorization: Bearer — bypasses Turnstile on POST /api/scan
                      (or GHFIND_API_KEY)
--github-token <t>    for exists (or GITHUB_TOKEN)
--byo-base-url/-api-key/-model   your OpenAI-compatible provider for roast
--json | -o json|pretty|markdown
--lang zh|en
```

### Managing the ghfind Review bot

`ghfind bot` manages the [ghfind Review GitHub App](https://bot.ghfind.com) on
repositories you administer. It needs a personal API token (`ghf_...`, from
[ghfind.com/integrations](https://ghfind.com/integrations)) in `GHFIND_API_KEY`
or `--api-key`. Explicitly select **Manage the ghfind Review bot** when creating
the token. Existing tokens remain scan-only; create a new token to opt into bot
access. Reading needs write access to the repository and every change
needs admin. `GHFIND_BOT_HOST` or `--bot-host` overrides `https://bot.ghfind.com`.
Cleanup is two-step: the first command only previews, the second executes.

```bash
ghfind bot status owner/repo
ghfind bot settings set owner/repo --triage on --allowed-labels bug,feature
ghfind bot pause owner/repo
ghfind bot cleanup owner/repo --labels all --comments     # preview, prints a confirm token
ghfind bot cleanup confirm owner/repo <token> --wait      # execute that preview
ghfind bot resume owner/repo
```

Also: `bot whoami`, `bot settings get`, `bot backfill <repo> [-n 25]`,
`bot retry <repo> [job-id]`, `bot cleanup status|cancel <repo> <cleanup-id>`.
API errors exit 1 with the server's code, e.g. `(admin_required)`.

---

## Library

```python
from ghfind import GhFind

gh = GhFind()  # defaults to https://ghfind.com

# Cheapest: deterministic score (no LLM). Works for ANY account —
# unseen ones go through the Go quick-scan worker. s["source"] is
# "indexed", "quick", or "legacy_v5_v5_v3".
s = gh.get_score("torvalds")
print(s["final_score"], s["tier"], s["percentile"], s["source"])

# Full evidence payload:
scan = gh.scan("torvalds")
print(scan["scoring"]["final_score"], scan["scoring"]["red_flags"])

# Confirm a handle exists first (on your IP, not ghfind's):
if gh.user_exists("torvalds"):
    ...

# Roast with your own model (no ghfind LLM spend):
roast = gh.roast("torvalds", byo_key={
    "baseURL": "https://api.openai.com/v1", "apiKey": "...", "model": "gpt-4o",
})
```

Every method is one atomic capability; introspect them via
`from ghfind import CATALOG`.

### Local verification (`ghfind.local`)

```python
import os
from ghfind import GhFind
from ghfind.local import verify_scan, score_metrics

scan = GhFind(api_key=os.environ["GHFIND_API_KEY"]).scan("torvalds")
check = verify_scan(scan)   # {"verified", "local", "differences": [{"field", "server", "local"}]}
scoring = score_metrics(scan["metrics"])   # pure, no I/O
```

`ghfind.local` is the Python port of the public scoring module (`@ghfind/scoring`),
pinned bit-for-bit to the TypeScript and Go implementations by the shared
fixtures in `scoring/fixtures`. It makes no network calls and needs no token.

`collect_and_score` (local crawling) was removed in 0.2.0.

### Errors

```python
from ghfind import GhFindError
try:
    gh.get_score("someone")
except GhFindError as e:
    if e.status == 404:
        print("no such GitHub user")  # the only 404
```

---

Machine-readable API spec: <https://ghfind.com/openapi.json> · Agent notes:
<https://ghfind.com/llms.txt>

JS/TS SDK/CLI: [`@hikariming/ghfind` on npm](https://www.npmjs.com/package/@hikariming/ghfind). License: AGPL-3.0-or-later.
