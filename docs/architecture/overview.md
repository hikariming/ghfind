# System overview

How ghfind is built today: which code owns what, and what runs in production.
For the planned public/private repository split, see
[open-core-split.md](./open-core-split.md). For deployment, see the
[Cloudflare deployment runbook](../operations/cloudflare-deployment-runbook.md).

## Code modules

| Module | Where | Role |
| --- | --- | --- |
| **Scoring** (public) | [`scoring/`](../../scoring) — npm `@ghfind/scoring` + Go module, Python port in `packages/ghfind-py` | Pure functions: GitHub evidence → `RawMetrics` → six dimensions, risk rules, 0–100 score, rating ladder. No network, tokens, env or clock. Parity fixtures in `scoring/fixtures/`. |
| **Backend** | `src/lib/` (collector, persistence, rate limits, AI reports), `src/app/api/`, `apps/api`, `apps/coord`, `apps/talent`, `internal/backend` + `cmd/*` (Go) | GitHub collection with the token pool, scan admission and caching, D1 storage, roasts, projects, Feed, Talent Match. Scoring is reached only through thin facades (`src/lib/score.ts`, `internal/backend/scoring_bridge.go`). |
| **Frontend** | `apps/web` (Astro + React islands), `src/app` + `src/components` (Next, migrating), `packages/i18n` | Pages, share cards, badges. Renders `@ghfind/scoring` types and the rating ladder; display names and colours live in `src/lib/realm.ts`. |
| **SDKs + CLI** | `packages/ghfind-js`, `packages/ghfind-py`, `cmd/ghfind` + `internal/agentcli` | Remote API clients. The SDKs can also re-score a scan locally (verify-only, no crawling). |
| **GitHub App** | `platform/github-app` | ghfind Review: labels issues and PRs with the author's score band. |

## Production runtime (Cloudflare)

```text
                     ghfind.com
                         │
                  ghfind-router            picks a Worker per path (apps/router/src/routes.ts)
          ┌──────────────┼───────────────────┐
     ghfind-web      ghfind-api          ghfind (legacy Next, OpenNext)
     Astro pages     Hono /api/*          /_next assets and not-yet-migrated /api routes
          │              │  ├─ D1: GHFIND_D1 (core), GHFIND_FEED_D1 (Feed) · R2: Feed media
          │              │  ├─ Workflow → ghfind-talent   (Talent Match reports, job sync)
          └── reads D1   │  └─ Durable Objects → ghfind-coord (rate limits, scan slots, roast jobs)
                         │
                 GitHub REST/GraphQL (token pool) · LLM providers · Mosoo (project analysis)

ghfind-cost-monitor   independent Worker polling Cloudflare analytics every 5 min
```

- **Router** (`apps/router`): owns the hostname. Pages go to `ghfind-web`, migrated
  API routes to `ghfind-api`, and Next build assets plus unmigrated routes to the
  legacy `ghfind` Worker. `ROUTER_FORCE_LEGACY` sends everything to legacy.
- **Coordination** (`apps/coord`): Durable Objects that are replacing Upstash Redis
  (rate limiting first; locks and scan admission next). Upstash is still configured
  for the legacy Worker.
- **Go services** (`internal/backend`, `cmd/*`, `Dockerfile.backend`,
  `Dockerfile.feed`): the portable Feed runtime ([ADR 001](../adr/001-portable-feed-runtime.md))
  and the retired Go API. They are not on the production request path today; the
  `src/lib/go-*.server.ts` modules keep their historical names but read D1 directly.

## A score request, end to end

1. `GET /api/score/{user}` (no auth) returns the stored score if one exists. An
   unseen account is admitted to a bounded quick scan.
2. A full scan (`POST /api/scan`, Turnstile or machine auth) collects public
   GitHub evidence with the server token pool (`src/lib/github.ts`), derives
   `RawMetrics` (`@ghfind/scoring/extract`) and scores it (`@ghfind/scoring`).
3. The result is persisted to D1 **before** it is returned; a scan that cannot be
   saved fails rather than publishing an unsaved score.
4. `POST /api/roast` streams the AI report. The model writes tags and prose only;
   it never changes the score or rating.

## Where to change things

| Change | Start here | Must also update |
| --- | --- | --- |
| Score formula, risk rules, rating ladder | `scoring/` | Go + Python ports, `scoring/fixtures/`, backend score version, AGENTS.md business rules |
| GitHub collection, token pool, rate limits | `src/lib/github.ts`, `src/lib/scan-*`, `apps/coord` | Nothing in `scoring/` may import these |
| Page or UI | `apps/web` (new), `src/components` (shared islands) | AGENTS.md Frontend Stack Rules and Theme Checks |
| Route ownership | `apps/router/src/routes.ts` | SEO diff for migrated pages (AGENTS.md "Astro Migration") |
| Deployment | `wrangler.jsonc`, `apps/*/wrangler.jsonc`, `.github/workflows/deploy-*` | [Cloudflare runbook](../operations/cloudflare-deployment-runbook.md) |
