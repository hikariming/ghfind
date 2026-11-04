# Open-core split: scoring / backend / frontend

Status: phase 1 implemented (scoring module extracted inside this repo); the
private repository is **not created yet**. Date: 2026-11-03. Baseline:
`origin/main` at `dd3ac21d`.

## 1. Goal

ghfind moves from fully open source to open core:

- **Public** (`hikariming/ghfind`): the scoring rubric, so anyone can verify how a
  score and rating are derived, plus SDKs, the CLI and (phase 2) lightweight
  frontend elements.
- **Private** (`<org>/ghfind-backend`): GitHub collection, the production token
  pool, traffic management, storage, AI reports, Feed, deployment.

## 2. Starting point: what was coupled

| Concern | Where it lived | Coupling |
| --- | --- | --- |
| Score formula | `src/lib/score.ts`, `internal/backend/scoring.go`, `packages/ghfind-py/ghfind/_score.py` | Three ports, parity tested only through fixtures inside the app's `src/lib/__tests__`. |
| Evidence → metrics | ~1.4k lines inside `src/lib/github.ts` (5.5k lines) | Pure derivation mixed with GitHub API calls in the same file. |
| GitHub token pool | `src/lib/github.ts` (`githubTokens`, `pickToken`), `internal/backend/github_client.go` | Same file as the derivation above. |
| Traffic management | `src/lib/redis.ts`, `src/app/api/scan/route.ts` | Rate limits, scan coalescing, Turnstile and caching in the same request path as `score()`. |
| Rating ladder | `src/lib/realm.ts` (site), `packages/ghfind-py/ghfind/_cli.py` (copy) | Two hand-maintained copies that had already drifted (English names, `inf` handling). |
| Risk rules | `config/risk-rules-v10.json` | Rubric parameters stored in app config. |
| Deployable | One Cloudflare release: Next worker (pages + `/api/*` + scanner) + Go Feed container | Frontend and backend are one artifact today. |

## 3. Target architecture

```text
                    PUBLIC  hikariming/ghfind                          PRIVATE  <org>/ghfind-backend
 ┌──────────────────────────────────────────────┐        ┌────────────────────────────────────────────────┐
 │ scoring/   @ghfind/scoring  +  Go module     │ semver │ backend                                         │
 │   types.ts      RawMetrics/evidence contract │───────▶│   GitHub collector (API, pagination, retries)   │
 │   extract.ts    evidence -> RawMetrics       │  npm + │   token pool (multiple users' tokens), quotas   │
 │   score.ts/risk.ts  RawMetrics -> Scoring    │  go get│   traffic: rate limit, coalescing, Turnstile    │
 │   rating.ts     30–100 ladder, Lv            │        │   storage (D1/Turso/Postgres), queues, Feed     │
 │   rules/        risk parameters              │        │   AI reports, GitHub App, admin, deploy         │
 │   fixtures/     cross-runtime parity cases   │        │                                                 │
 │ packages/ghfind-py, ghfind-js, cmd/ghfind    │  HTTP  │ frontend (phase 1: still the Next/Astro apps)   │
 │   SDKs + CLI (remote API + verify-only)      │◀──────▶│   pages call /api/*; render with                │
 │ ui/ (phase 2) presentational components      │        │   @ghfind/scoring types + rating ladder         │
 └──────────────────────────────────────────────┘        └────────────────────────────────────────────────┘
```

### Module responsibilities and rules

**scoring** (public, `scoring/`): a pure function of already-collected public
evidence. It is enforced by `scripts/check-scoring-boundary.mjs` (CI):

- TS sources import only sibling modules and `../rules/*.json`; they cannot use
  `fetch`, `process`, `globalThis`, dynamic `import`/`require`, timers,
  `Date.now`, `Math.random`, storage or `crypto`. `scoring/tsconfig.json` also
  compiles `src/` with lib `ES2022` only (no DOM, no Node types).
- Go sources import only `embed errors fmt math regexp sort strconv strings
  unicode unicode/utf8`.
- No GitHub credential may appear anywhere under `scoring/`.
- Consumers import `@ghfind/scoring/<module>` / the Go module path, never a
  relative path into `scoring/src`, so swapping the workspace link for a
  registry version is one line.

**backend** (private): everything that touches GitHub, users' tokens,
production data or traffic. It depends on scoring by **version**.

**frontend**: talks to the backend only over HTTP (`/api/score/{u}`, `/api/scan`,
…) and uses scoring for types and the rating ladder. Phase 1 leaves the Next
and Astro apps in the private repo because pages, API routes and server data
access share one deployable. Phase 2 extracts the presentational layer into a
public `ui/` package (see §8).

### The token pool stays private by construction

Production scans rotate through a pool of multiple users' GitHub tokens. None
of the following is, or may become, part of the public module: `githubTokens`,
`pickToken`, `withGithubToken`, `ParseGitHubTokens`, retry and rotation budgets,
quota accounting, or which accounts donated tokens. The scoring module has no
parameter that accepts a token, its CI runs with `GITHUB_TOKEN=""`, and fixture
recording (`scripts/record-score-fixtures.mts`, which needs a live token) stays
private. Recorded fixtures are anonymized (`scoring/tools/anonymize-fixture.ts`,
tested by `scoring/test/fixture-anonymization.test.ts`).

## 4. Rating system

The current rating is the **30–100 ladder with one rating every 10 points**:
`[0,30)` qi · `[30,40)` foundation · `[40,50)` goldenCore · `[50,60)` nascentSoul ·
`[60,70)` deity · `[70,80)` voidRefining · `[80,90)` integration · `[90,100]`
mahayana. Scores exactly on a threshold belong to the higher rating, and
`Lv = floor(score)` clamped to 1–100.

- Canonical rule: `scoring/src/rating.ts` (TS), `scoring/rating.go` (Go).
  Python's CLI table is pinned by `packages/ghfind-py/tests/test_rating.py`.
  All three are tested against `scoring/fixtures/rating-ladder.json`, which CI
  regenerates from the TS reference.
- `src/lib/realm.ts` keeps only presentation (names, colors, glyphs, effects)
  and reads thresholds and ranks from the ladder.
- **Legacy:** `tierFor()` (40 / 70 / 80 / 90 → 拉完了 … 夯) is still written into
  every stored `Scoring.tier` and drives the Review bot buckets. It is
  unchanged, so stored snapshots, caches and score versions are unaffected.
  Retiring it is a separate, versioned scoring change (§9).

## 5. What phase 1 changed (this branch)

- New `scoring/` module containing:
  - `src/` with `score`, `risk`, `legacy-risk`, `presentation-concentration`,
    `co-creator`, `score-presentation`, `score-red-flags`, `types` (evidence +
    RawMetrics + Scoring contract), the new `rating`, and `extract`. `extract.ts`
    holds 135 pure declarations moved verbatim from `src/lib/github.ts` with the
    TypeScript AST, not by hand.
  - `*.go`: the Go formula, risk, presentation and rating, plus the evidence
    types `RecentPR`, `PRFileChange` and `ImpactRepo`. It is module
    `github.com/hikariming/ghfind/scoring`.
  - `fixtures/`: 16 parity fixture files, also embedded for Go as
    `github.com/hikariming/ghfind/scoring/fixtures`.
  - `rules/risk-rules-v10.json`, `test/` (13 suites) and `tools/`.
- The app keeps its import paths: `src/lib/{score,risk,…}.ts` are one-line
  facades over `@ghfind/scoring/*`, `src/lib/types.ts` re-exports the contract,
  and `src/lib/github.ts` imports or re-exports the moved derivation.
- `internal/backend/scoring_bridge.go` aliases the moved Go types and helpers,
  so backend call sites and JSON are unchanged. Root `go.mod` uses
  `replace … => ./scoring`, and the Dockerfiles copy `scoring/`.
- Gates: `pnpm scoring:boundary` and `node ops/open-core/split.mjs check` run
  in `ci.yml`, and `.github/workflows/scoring.yml` is the standalone public
  scoring CI.
- No formula, threshold, output or stored-format change. All existing TS, Go
  and Python suites pass, and both Go Docker images build.

## 6. Versioning and cross-repo CI/CD

One tag versions every runtime: `scoring/vX.Y.Z` (the nested Go module tag
format) = npm `@ghfind/scoring@X.Y.Z` = Go `github.com/hikariming/ghfind/scoring@vX.Y.Z`.

```text
public PR ─▶ scoring.yml (TS/Go/Py parity, boundary; no secrets, fork-safe)
    │ merge to main
    ▼
nightly ◀── private: scoring-upstream-canary.yml  (private suite vs public main; opens an issue on break)
    │ maintainer pushes tag scoring/vX.Y.Z
    ▼
scoring-release.yml  (environment: scoring-release, reviewers required)
    ├─ re-runs scoring.yml
    ├─ npm publish (if vars.SCORING_NPM_PUBLISH) + GitHub release (tarball, fixtures)
    └─ repository_dispatch "scoring-released" ──▶ private: scoring-bump.yml
                                                    ├─ pnpm add / go get vX.Y.Z
                                                    ├─ private typecheck + tests + go test
                                                    └─ opens PR ─▶ private CI ─▶ existing deploy workflows
```

When the backend needs a rubric change, it lands upstream first as a public PR,
then flows back in through a release. The private repo never vendors or edits
scoring sources.

### Settings to create (none exist yet)

| Where | Name | Purpose |
| --- | --- | --- |
| public · environment `scoring-release` | required reviewers | Gate every release. |
| public · env secret | `BACKEND_DISPATCH_APP_KEY` | Private key of a GitHub App installed **only** on the private repo with *Contents: read & write* (needed for `repository_dispatch`). |
| public · variables | `BACKEND_DISPATCH_APP_ID`, `BACKEND_REPOSITORY` (`org/name`), `BACKEND_REPOSITORY_OWNER`, `BACKEND_REPOSITORY_NAME` | Dispatch target; the step is skipped while unset. |
| public · variables | `SCORING_NPM_PUBLISH` (`true`), `SCORING_NPM_REGISTRY` | Enable npm publishing. The `@ghfind` scope must exist on the registry. |
| public · env secret | `SCORING_NPM_TOKEN` | npm automation token. |
| private · variable | `SCORING_SOURCE` = `npm` or `github-release` | Where `scoring-bump.yml` installs the package from. |

A GitHub App is preferred over a PAT: its tokens are short-lived, scoped to one
repository, and not tied to a person.

## 7. Cutover runbook

Prerequisites:

1. **Licensing decision** (§10).
2. Create the org and the **private** repo (owner action).
3. Public→private references: **cleared** (`split.mjs blockers` reports 0).
   The SDKs are verify-only as of `@hikariming/ghfind` / `ghfind` (PyPI) 0.2.0:
   `ghfind/local` bundles `@ghfind/scoring` (`scoreMetrics`, `verifyScan`, the
   rating ladder), the Python SDK keeps only its scoring port plus the pure
   `_extract.py`, and the crawling `--local` / `collectAndScore` /
   `collect_and_score` paths are gone (the CLIs gained `scan --verify` and an
   offline `verify <scan.json>`). Publish both SDK releases before the public
   cutover. `cutover public` refuses to run if this list is ever non-empty again.
4. Tag `scoring/v0.1.0` and confirm the npm package and Go module resolve.

Steps:

```sh
node ops/open-core/split.mjs plan                                   # review counts per side/module
node ops/open-core/split.mjs seed-private git@github.com:<org>/ghfind-backend.git          # dry run
node ops/open-core/split.mjs seed-private git@github.com:<org>/ghfind-backend.git --push   # full-history mirror
# in the private clone, on a branch:
node ops/open-core/split.mjs cutover private --apply   # drops public-only paths
#   then: package.json "@ghfind/scoring": "0.1.0" (remove "scoring" from pnpm-workspace.yaml),
#         go.mod require github.com/hikariming/ghfind/scoring v0.1.0 (drop replace),
#         Dockerfiles stop copying scoring/, copy ops/open-core/private-repo/.github/workflows/*,
#         move secrets/environments, point deploy workflows at the new repo.
# in the public repo, on a branch:
node ops/open-core/split.mjs cutover public --apply    # drops private-only paths
#   then: trim package.json/go.mod/Makefile/README to scoring + SDKs + CLI, keep scoring.yml and
#         scoring-release.yml, delete deploy/feed workflows and their secrets.
```

- The private repo starts from full history, so nothing is lost and blame is
  intact.
- Do **not** rewrite the public repo's history. The code is already published
  under AGPL; a rewrite breaks forks and revokes nothing.
- Run both repos' CI and a production deploy from the private repo before
  removing deploy credentials from the public one.

## 8. Phase 2: public frontend module

The goal is a `ui/` package (`@ghfind/ui`) holding presentational, data-free
components: the score card, dimension star chart, rating badge and realm
visuals (`src/lib/realm.ts` presentation, `src/lib/tier.ts`,
`src/components/DimensionStarChart.tsx`, `public/tier-emoji`), plus
`src/components/ui` primitives. All of it stays under the Frontend Stack Rules
in `AGENTS.md`. Components receive `Scoring` / `RawMetrics` props and never
fetch. A minimal public demo can render a score from `/api/score/{u}` or from a
pasted RawMetrics JSON. Until then, the manifest classifies these files as
private.

## 9. Decisions still open

- Retire the legacy five-tier `Scoring.tier` in favour of the rating ladder. This
  needs a score-version bump, a bot label migration and an update to the
  AGENTS.md tier rule.
- Unify CLI rating display names with the site. The Python CLI says
  "Mahayana"; the site says "Grand Ascension".
- Choose the npm registry and scope (`@ghfind` on npmjs vs GitHub Packages).
- Choose a vanity import path for the Go module, if the public repo may ever
  move.

## 10. Licensing (blocking)

The repository is AGPL-3.0-or-later with no CLA, and backend files carry
commits from contributors other than the maintainers. Before code runs as a
closed network service:

- AGPL §13 entitles network users of a modified AGPL program to its source.
  Keeping backend code private therefore requires relicensing permission from
  every copyright holder of that code, or replacing their contributions.
- If `@ghfind/scoring` stays AGPL, a private backend that links it is arguably a
  combined work under the same obligation. Relicensing the scoring module
  under a permissive licence (Apache-2.0 or MIT) avoids that, and needs the same
  contributor consent for the files involved.
- Versions already released stay AGPL for everyone who received them.
- Add a CLA or DCO-plus-licence-grant to the public repo before accepting new
  contributions.

Get legal review. This section is an engineering flag, not legal advice.
