# ghfind (Python)

Official Python SDK **and CLI** for **[ghfind.com](https://ghfind.com)** — score any
GitHub account **0–100** for value and trustworthiness, with roasts, head-to-head
battles, leaderboards, and developer discovery.

- **Deterministic scoring, no LLM.** `scan`, `score`, `get_score`, and the battle
  winner are pure computation over GitHub data: the score is devscore's v3 score
  (score v11).
- **Bring your own model.** The only LLM parts are the *roast prose* and *battle
  commentary*. `roast(..., byo_key=...)` runs the LLM through your own
  OpenAI-compatible provider — or just feed the structured `scan()` output to your
  own model.
- **First-time scores take a while.** devscore collects each account across GitHub,
  ecosyste.ms and GH Archive, which takes minutes for large accounts. The server does
  this in a background job; the SDK waits for it (see *Pending scores* below).
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
rate-limited on the server. Already-scored accounts answer immediately; an account
ghfind has never scored is queued for background devscore scoring and the CLI waits
for it (up to `--wait` seconds, default 900). It's the cheapest path for you *and*
for ghfind.

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

### Pending scores

A never-scored account answers `202 Accepted` with a status `Location`
(`/api/scan/status/{user}`); every poll of that Location advances the job. The CLI
polls it with backoff (2 s growing to 15 s). If the score is still being computed
when `--wait` runs out, `score`/`scan` exit with code **3** and print the status
URL — run the same command again later.

```bash
ghfind score someone-new --wait 60   # give up after a minute (exit 3 if pending)
```

### Options & environment

```
--host <url>          default https://ghfind.com (or GHFIND_HOST)
--api-key <key>       Authorization: Bearer — bypasses Turnstile on POST /api/scan
                      (or GHFIND_API_KEY)
--github-token <t>    for exists (or GITHUB_TOKEN)
--wait <seconds>      score/scan: max wait for a first-time score (default 900)
--byo-base-url/-api-key/-model   your OpenAI-compatible provider for roast
--json | -o json|pretty|markdown
--lang zh|en
```

---

## Library

```python
from ghfind import GhFind

gh = GhFind()  # defaults to https://ghfind.com

# Cheapest: deterministic score (no LLM). Works for ANY account — a
# never-scored one is computed by a background job first (see below).
# s["source"] is "indexed", "quick", or "legacy_v5_v5_v3".
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

### Pending scores

`get_score`, `scan` and `score` follow a `202` job's status Location with backoff
for up to `wait` seconds (default `DEFAULT_WAIT_SECONDS` = 900; `wait=0` does not
poll) and raise `GhFindPending` if the score is still being computed:

```python
from ghfind import GhFindPending
try:
    s = gh.get_score("someone-new", wait=30)
except GhFindPending as p:
    print("still computing:", p.job, "poll", p.status_url)  # call again later
```

There is no local scoring mode: the published score is devscore's, which needs
the server-side collection (GitHub, ecosyste.ms, ClickHouse GH Archive). Versions
before 0.2 shipped a local port of the retired v10 scorer; its numbers no longer
match the site.

### Errors

```python
from ghfind import GhFindError, GhFindPending
try:
    gh.get_score("someone")
except GhFindPending:
    ...  # still computing (a GhFindError subclass with status 202)
except GhFindError as e:
    if e.status == 404 or e.code == "account_not_found":
        print("no such GitHub user")
```

---

Machine-readable API spec: <https://ghfind.com/openapi.json> · Agent notes:
<https://ghfind.com/llms.txt>

JS/TS SDK/CLI: [`@hikariming/ghfind` on npm](https://www.npmjs.com/package/@hikariming/ghfind). License: AGPL-3.0-or-later.
