# Backend route ownership matrix

This matrix is the cutover checklist for issue #170. A route is only marked
**Go-owned** after its Next handler contains no direct data/business dependency,
its same-origin rewrite is enabled, and its Go contract test is green. Image and
document renderers may remain in Next, but their data must come from Go rather
than Turso/Redis/GitHub/LLM directly.

| Surface | Current cutover status | Contract to preserve |
| --- | --- | --- |
| `GET /api/stats` | Go-owned | `{total,cached}`, `stats:count` 60s cache key and existing CDN header |
| `GET /api/search-users` | Go-owned | user/repo/facet result shape, empty arrays and 300s CDN header |
| `GET /api/score/{username}` | Go-owned | canonical/legacy score read, durable worker quick scan, rate-limit/error/cache semantics |
| Go profile presentation reads | Go-owned | `/api/profile/{username}` and cached-only `/live` preserve version-gated profile artifacts, snapshot/rank/similar/common-project/read-only matchup data for Next renderers |
| `GET /api/vs/{a}/{b}`, `GET /api/vs/trending` | Go-owned | canonical pair read, null unscored players, stored LLM verdict shape and trending ordering |
| `GET /api/sitemap` | Go-owned | indexable profile and LLM-verdict pair inventory; Next keeps locale/static URL assembly |
| `POST /api/scan` | Go-owned | Turnstile/machine auth, idempotent queue admission, compatibility wait, `202 Location` fallback and worker persistence-before-result |
| `POST /api/roast` | Go-owned | exact `0x1f` stream frames, `X-Roast-Meta`, BYO key never persisted |
| `POST /api/vs-verdict` | Go-owned via BotID gateway | BotID/rate-limit protection, deterministic winner and cached LLM copy |
| `GET /api/leaderboard` | Go-owned | views, windows, pagination, `cached` field and CDN contract |
| `GET /api/developers` | Go-owned | language/org/repo validation, category and bucket cache keys, pagination and CDN contract |
| Go project presentation reads | Go-owned | bounded project lists, repo overview, related-project graph and canonical contributor aggregates for Next renderers |
| `GET /api/facet-rank/{username}` | Go-owned | 10/min public-read sliding limit, rank/null shape and CDN contract |
| profile/blog/collection comments, reactions, follows | Go-owned | OAuth/anonymous authorization, write status and no-store headers |
| `/api/me` and `/api/auth/*` | Go-owned | GitHub OAuth callback/session-cookie behavior and user upsert |
| profile/admin backfills | Go-owned | constant-time `ADMIN_SECRET` gate; index rebuilds are bounded/paginated, profile refresh submits durable scans; canonical-score replay remains explicitly paused pending its provenance cursor job |
| campaign leaderboard + events | Go-owned | `advx` allowlist, public/live budgets, pagination redirect, SSE reconnect/cap/revision behavior |
| `/mcp` | Go-owned | stateless Streamable HTTP SSE, five read-only tool schemas, `rl:mcp` 15/min key and deterministic tool payloads |
| machine documents | Next static | server card/OpenAPI/agent docs remain static discovery surfaces and contain no Turso, Redis, GitHub or LLM reads |
| `GET /api/badge/{username}` | Next renderer / Go data | stable SVG and cache headers; Go owns score + weekly-delta read model |
| card/material-card/OG routes | Next renderer / Go data | Next renders bytes; profile, rank, weekly-delta, snapshot and VS inputs are Go presentation reads |
| profile, VS, leaderboard, developer-directory pages and sitemap | Next renderer / Go data | no direct Turso/Redis/GitHub/LLM reads on these migrated server surfaces |
| project/repo graph pages | Next renderer / Go data | list/overview/related graph reads are Go-owned; Next retains cards and controls |

## Queue ownership

`score_snapshot.v1` is the first real asynchronous workload. It is admitted by
the Go API, persisted as a job-status value in the existing Upstash instance,
delivered by durable RabbitMQ queues, and materialized by the Go worker into the
existing `score_snapshots` table. The job ID is the snapshot primary key, so
duplicate delivery is safe. Retries use a TTL retry queue; terminal messages go
to `ghfind.score-snapshot.dead.v1` and remain inspectable.

`scan.quick.v1` is the public asynchronous business workload. The Go API admits
the scan, stores a queryable Upstash status, publishes a durable RabbitMQ
message, and waits only long enough to preserve the existing synchronous
contract. The independently restartable Go worker performs GitHub collection,
Go scoring and existing Turso persistence. Duplicate deliveries are guarded by
`public_scan_runs.id`, terminal failures are written to job status and
`ghfind.scan.quick.dead.v1`, and both processes expose Prometheus text metrics:
`ghfind_api_job_admissions_total`, `ghfind_api_scan_waits_total`,
`ghfind_worker_jobs_*_total`, `ghfind_worker_jobs_dead_lettered_total`, and
`ghfind_worker_job_duration_seconds_*`.

Future project analysis and provider callbacks must register a row in this
matrix before implementation, including their request signature, idempotency
key, persistence target, retry/DLQ policy and public status contract.

The `backend extraction boundary` Vitest suite scans Next runtime source under
`src/app` and `src/components` so UI/rendering code may use type-only contracts
or Go presentation helpers, but cannot reintroduce direct DB, Redis, GitHub,
LLM, scan or score business modules.

Next route files left under `src/app/api` are deployment-misconfiguration
guards. They intentionally return `503 backend_not_configured`; they are not a
rollback copy of the old business implementation. Vercel must use the
`beforeFiles` rewrites in `next.config.ts` for Go-owned paths so those guard
files do not run during a healthy cutover.

## Vercel-bound verification gateways

`POST /api/vs-verdict` requires Vercel BotID. Its verification API consumes
Vercel's OIDC request context and mutates challenge response headers, neither
of which exists at the independent Go origin. During its migration, the Next
route remains a minimal BotID gate that forwards an already-verified request
to Go; no Turso, Redis, prompt, or LLM business logic remains in that gateway.
It HMAC-binds the raw body, issued time and Vercel-observed client identity
with `GHFIND_VERDICT_GATEWAY_SECRET`. Configure that transport credential only
in the Go API and Vercel server environments, never in the worker or browser;
Go rejects a direct Railway call without it. Do not add a direct rewrite for
this route because it would bypass BotID. The gateway ignores caller-supplied
generic `X-Forwarded-For` and binds only Vercel's platform client-IP header
when present; the Go API likewise ignores generic forwarding headers unless
`GHFIND_TRUST_VERCEL_HEADERS=1` is explicitly enabled behind restricted ingress.
