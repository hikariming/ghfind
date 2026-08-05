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
- **Score anywhere.** No token → the ghfind server crawls + scores for you. Have a
  token → `ghfind.local` runs the *same* open-source engine entirely on your
  machine (see below). Same numbers either way.
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

`*` `roast`/`vs` prose is the only LLM part. Pass `--byo-base-url --byo-api-key
--byo-model` (or `GHFIND_BYO_*` env vars) to run `roast` through your own model
instead of ghfind's.

### Score locally, offline, on your own token

`--local` runs the crawl **and** scoring on your machine with your `GITHUB_TOKEN`
— the ghfind server is never called, so it scales infinitely and never adds load:

```bash
export GITHUB_TOKEN=ghp_xxx
ghfind score torvalds --local     # crawl + score entirely on your machine
ghfind scan torvalds  --local
```

Rule of thumb: **have a token → `--local`** (offline, unlimited); **no token →
plain `score`** (ghfind scores it for you). Output is identical.

### Options & environment

```
--host <url>          default https://ghfind.com (or GHFIND_HOST)
--api-key <key>       Authorization: Bearer — bypasses Turnstile on POST /api/scan
                      (or GHFIND_API_KEY)
--github-token <t>    for --local and exists (or GITHUB_TOKEN)
--byo-base-url/-api-key/-model   your OpenAI-compatible provider for roast
--json | -o json|pretty|markdown
--lang zh|en
```

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

### Local scoring (`ghfind.local`)

```python
import os
from ghfind.local import collect_and_score

scan = collect_and_score("torvalds", token=os.environ["GITHUB_TOKEN"])
print(scan["scoring"]["final_score"], scan["scoring"]["tier"])

# Already have metrics? Score them purely (no I/O):
from ghfind.local import score_metrics
scoring = score_metrics(metrics)
```

`ghfind.local` is a faithful port of the website's `collect()` + `score()`,
verified bit-for-bit against the TS/website output. It runs entirely on your own
machine and GitHub token — no ghfind server, no LLM, no rate limits but GitHub's.

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
