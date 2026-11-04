# ghfind

Official JavaScript/TypeScript SDK **and CLI** for **[ghfind.com](https://ghfind.com)** —
score any GitHub account **0–100** for value and trustworthiness, with roasts,
head-to-head battles, leaderboards, and developer discovery.

- **Deterministic scoring, no LLM.** `score`, `scan`, `getScore`, and the battle
  winner are pure computation over GitHub data.
- **Bring your own model.** The only LLM parts are the *roast prose* and *battle
  commentary*. `roast(..., { byoKey })` runs the LLM through your own
  OpenAI-compatible provider — or just take the structured `scan()` output and
  feed your own model.
- **Verifiable.** The scoring module is open source. `ghfind/local` recomputes
  any scan's score on your machine from its published evidence (see below).
- **Zero runtime dependencies.** Uses the global `fetch` (Node 18+, browsers, edge).

```bash
npm install @hikariming/ghfind      # library
npm install -g @hikariming/ghfind   # or global CLI (exposes the `ghfind` command)
```

> Published as **`@hikariming/ghfind`** (the unscoped `ghfind` name is blocked by
> npm for being too similar to `find`). The CLI command is still `ghfind`.

---

## CLI

```bash
# after `npm i -g @hikariming/ghfind`, or one-off via `npx @hikariming/ghfind <cmd>`
ghfind score torvalds          # deterministic score (no auth, cached)
ghfind roast torvalds --lang en
ghfind vs torvalds octocat
ghfind badge torvalds --markdown   # a README badge that links back to ghfind
ghfind update check                 # check whether the local CLI is stale
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
| `update check` | Compare the local CLI with the latest GitHub release. | GitHub releases API | no |
| `update install` | Download and replace the local release binary, or use `--method npm\|pip\|brew`. | GitHub releases API | no |
| `commands [show <c>]` | Self-describing capability catalog (for agents). | — | no |
| `auth status` | Show host + which credentials are configured. | — | no |

`*` `roast`/`vs` prose is the only LLM part. Pass `--byo-base-url --byo-api-key
--byo-model` (or `GHFIND_BYO_*` env vars) to run `roast` through your own model
instead of ghfind's.

### Verify a score locally

Every score is a pure function of its published evidence. `--verify` re-scores a
scan with the open-source scoring module bundled in the CLI (`@ghfind/scoring`) —
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

### Updating the CLI

`ghfind update check` only reports whether a newer release exists. It never
changes the local install.

Use `ghfind update install --method binary --dry-run` to inspect the selected
release asset and target path, then remove `--dry-run` to replace the current
binary. Package-manager shortcuts are explicit:

```bash
ghfind update npm --dry-run
ghfind update npm   # npm install -g @hikariming/ghfind@latest
ghfind update pip   # python3 -m pip install --upgrade ghfind
ghfind update brew  # brew upgrade ghfind
```

### Managing the ghfind Review bot

`ghfind bot` manages the [ghfind Review GitHub App](https://bot.ghfind.com) on
repositories you administer. Create a personal API token at
[ghfind.com/integrations](https://ghfind.com/integrations), explicitly select
**Manage the ghfind Review bot**, and set it as `GHFIND_API_KEY` or `--api-key`.
Existing tokens remain scan-only; create a new token to opt into bot access.
Reading needs write access to the repository and every change needs admin.
Cleanup is two-step: the first command only previews, the second executes.

```bash
ghfind bot status owner/repo
ghfind bot pause owner/repo
ghfind bot cleanup owner/repo --labels all --comments     # preview, prints a confirm token
ghfind bot cleanup confirm owner/repo <token> --wait      # execute that preview
ghfind bot resume owner/repo
```

---

## Library

```ts
import { GhFind } from "@hikariming/ghfind";

const gh = new GhFind(); // defaults to https://ghfind.com

// Cheapest: deterministic score (no LLM), works for ANY account.
const s = await gh.getScore("torvalds");
console.log(s.final_score, s.tier, s.percentile, s.source); // "indexed" | "quick" | "legacy_v5_v5_v3"

// Full evidence payload:
const scan = await gh.scan("torvalds");
console.log(scan.scoring.final_score, scan.scoring.red_flags);

// Confirm a handle exists first (on your IP, not ghfind's):
if (await gh.userExists("torvalds")) { /* ... */ }

// Roast with your own model (no ghfind LLM spend):
const roast = await gh.roast({
  username: "torvalds",
  byoKey: { baseURL: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o" },
});
```

Every method is one atomic capability; introspect them at runtime via
`import { catalog } from "@hikariming/ghfind"`.

### Local verification (`ghfind/local`)

```ts
import { GhFind } from "@hikariming/ghfind";
import { verifyScan, scoreMetrics, ratingForScore } from "@hikariming/ghfind/local";

const scan = await new GhFind({ apiKey: process.env.GHFIND_API_KEY }).scan("torvalds");
const check = verifyScan(scan);       // { verified, local, differences: [{ field, server, local }] }
const scoring = scoreMetrics(scan.metrics);   // pure, no I/O
ratingForScore(scoring.final_score);  // { id: "mahayana", minScore: 90, rank: 8 }
```

`ghfind/local` bundles the public scoring module (`@ghfind/scoring`) — the same
code the service scores with — so an untouched scan always verifies. A difference
means the scan was altered or was scored by a different scoring version (upgrade
the SDK). It makes no network calls and needs no token. The main
`@hikariming/ghfind` entry stays a tiny dependency-free remote client and never
pulls it in.

`collectAndScore` (local crawling) was removed in 0.2.0.

---

Machine-readable API spec: <https://ghfind.com/openapi.json> · Agent notes:
<https://ghfind.com/llms.txt>

Python SDK/CLI: [`ghfind` on PyPI](https://pypi.org/project/ghfind/). License: AGPL-3.0-or-later.
