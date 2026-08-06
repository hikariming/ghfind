# Go backend extraction runbook

## Ownership and topology

The Vercel application retains only UI, static resources and transparent
same-origin rewrites. `GHFIND_BACKEND_ORIGIN` is configured in Vercel's
**server-only** environment to point at the Go API. Browsers and SDKs continue
to call `https://ghfind.com/api/*`. The backend rewrites are `beforeFiles`
rewrites so Go-owned paths win over the fail-closed Next route files that remain
only as deployment guards.

The currently migrated public routes are `GET /api/stats`,
`GET /api/search-users`, `GET /api/leaderboard`, `GET /api/developers`,
`GET /api/facet-rank/{username}`, `GET /api/score/{username}`, `POST /api/scan`, `POST /api/roast`,
OAuth/session routes, and social interactions (follows, comments, reactions).
Server-rendered profile, VS, leaderboard, developer-directory, card and sitemap
surfaces also read their public presentation models directly from the Go API;
Next retains only page/image rendering and static route assembly.
Project lists and repository overview/related-project surfaces follow the same
model: Go owns graph reads while Next renders the discovery UI.
The unauthenticated `/mcp` Streamable HTTP transport is also Go-owned; Vercel
only rewrites the published root path to the API. It remains stateless, returns
JSON-RPC messages in SSE frames, and preserves the `rl:mcp` 15-per-minute
Upstash budget. The server-card and other agent documents remain static Next
responses.
`GET /api/badge/{username}` remains a Next SVG renderer, but gets its public
score/weekly-delta presentation model from Go (`/api/embed/badge/{username}`)
and therefore does not read Turso or Upstash.
The Go API also owns authenticated score-history job admission and status under
`/api/internal/jobs/*`. RabbitMQ delivers `score_snapshot.v1` work to a
separately deployed Go worker. The worker writes an existing `score_snapshots`
row, so duplicate delivery is safe and no Turso schema/data migration is
required. The public `scan.quick.v1` path uses the same durable queue fabric:
the Go API admits the job, the worker collects from GitHub, persists the
existing Turso score/profile records, and writes an Upstash terminal status
that the API can return or query.

## Required private environment

Configure these in the API and worker service, never as public Vercel values:

- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — existing database, unchanged.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — existing cache,
  storing finite job-status keys only.
- `RABBITMQ_URL` — use `amqps://` in production; do not expose the management
  port publicly.
- `ADMIN_SECRET` — required by the internal job endpoints.
- `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_SECRET`, `PUBLIC_SITE_URL` —
  API-only GitHub OAuth and signed-session configuration; do not give OAuth
  credentials to Vercel or the worker.
- `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` and optional
  `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL` —
  API-only operator-funded OpenAI-compatible providers. A visitor BYO key is
  accepted only in-memory for its one request and must never be logged, cached,
  queued, or persisted.
- `GHFIND_VERDICT_GATEWAY_SECRET` — required only for the BotID-bound
  `/api/vs-verdict` route. Set the same value in the API and Vercel **server**
  environment; it is a transport-authentication credential for that unavoidable
  Vercel verification gateway, not a browser value and not a worker secret.
- Optional: `GHFIND_JOB_STATUS_TTL` (default `168h`),
  `GHFIND_JOB_MAX_ATTEMPTS` (default `5`), `GHFIND_API_LISTEN_ADDR`,
  `GHFIND_TRUST_VERCEL_HEADERS=1` only after direct API ingress is restricted,
  `GHFIND_WORKER_METRICS_LISTEN_ADDR` (default `:9090`).
  On Railway, leave `GHFIND_API_LISTEN_ADDR` unset; the API process listens on
  the injected `PORT`. Set it only for local compose or a VPS/Kubernetes target
  with an explicit socket binding.

`GHFIND_BACKEND_ORIGIN` belongs only to Vercel's server environment after the
API is healthy. Keep it unset until cutover; then the existing Next route is
not invoked for migrated paths. The navbar/login UI treats a valid backend
origin as OAuth-enabled without reading OAuth secrets in Vercel; set the
non-secret `GHFIND_OAUTH_ENABLED=0` in Vercel only for an emergency login UI
kill switch.

### Vercel frontend deploy (staging or cutover)

With the Go API healthy at its public domain, deploy the frontend with four
server-side variables (never `NEXT_PUBLIC_*` for the backend origin):

```bash
vercel env add GHFIND_BACKEND_ORIGIN  # https://<ghfind-api-domain>
vercel env add PUBLIC_SITE_URL        # must equal the frontend origin
vercel env add NEXT_PUBLIC_SITE_URL   # same value as PUBLIC_SITE_URL
vercel env add GHFIND_OAUTH_ENABLED   # 0 keeps the login UI hidden pre-cutover
vercel deploy --prod                  # rewrites take effect at build time
```

Verify with `pnpm smoke:deployment` (variables in
`docs/releases/deployment-smoke.md`): it checks the `/u/` page, every Go-owned
`/api/*` surface through Vercel's rewrites, MCP, campaign SSE, and the
canonical profile origin.

## Local E2E smoke

1. Export the existing Turso/Upstash variables and an `ADMIN_SECRET`; never
   copy production secrets into committed files.
2. Run `docker compose -f docker-compose.backend.yml up --build`.
3. Verify `GET http://localhost:8080/healthz` and `/readyz` return `200`, and
   `GET http://localhost:9090/healthz` and `/readyz` return `200`. The worker
   `readyz` fails closed until Turso, Upstash and RabbitMQ all ping cleanly, so
   a degraded worker becomes visible to healthchecks instead of silently
   accumulating queue depth. Verify `GET http://localhost:8080/metrics` and
   `GET http://localhost:9090/metrics` return Prometheus text with
   `Cache-Control: no-store`.
4. Verify the migrated public contracts:

   ```sh
   curl -i http://localhost:8080/api/stats
   curl -i http://localhost:8080/metrics
   curl -i http://localhost:9090/metrics
   curl -i 'http://localhost:8080/api/search-users?q=octo'
   curl -i 'http://localhost:8080/api/leaderboard?view=trending&window=all'
   curl -i 'http://localhost:8080/api/developers?type=language'
   curl -i 'http://localhost:8080/api/score/octocat'
   curl -i 'http://localhost:8080/api/profile/octocat'
   curl -i 'http://localhost:8080/api/vs/octocat/torvalds'
   curl -i 'http://localhost:8080/api/projects?sort=quality&limit=18'
   curl -i 'http://localhost:8080/api/sitemap'
   curl -i -X POST http://localhost:8080/mcp \
     -H 'accept: application/json, text/event-stream' \
     -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   ```

   Check response shapes and cache headers against the existing same-origin
   routes. In particular, leaderboard uses `leaderboard:*` keys and developers
   uses `facets:cat:*` / `facets:list:*`; a cutover must reuse, not flush or
   rename, those existing Upstash keys. The score endpoint returns an indexed
   canonical score without spending a public-read token. On a cold account it
   submits the same durable quick-scan work consumed by `ghfind-scan-worker`
   and waits for the persisted result.
5. Submit an idempotent worker job and query it until `completed`:

   ```sh
   curl -i -X POST http://localhost:8080/api/internal/jobs/score-snapshot \
     -H "x-admin-secret: $ADMIN_SECRET" \
     -H 'idempotency-key: migration-smoke-001' \
     -H 'content-type: application/json' \
     --data '{"username":"octocat"}'
   ```

   Repeat the same request and confirm it returns the same `Location` and does
   not publish a second logical snapshot. Stop the worker during a queued job,
   start it again, and confirm the job completes. Force a Turso failure to
   verify retry and inspect `ghfind.score-snapshot.dead.v1` after the retry cap.
   The API metrics should include
   `ghfind_api_job_admissions_total{kind="score_snapshot.v1",result="queued"}`
   and the worker metrics should include
   `ghfind_worker_jobs_completed_total{kind="score_snapshot.v1",...}` plus
   `ghfind_worker_job_duration_seconds_count{kind="score_snapshot.v1"}`.
6. For the real public scan worker path, POST a cold or idempotent scan and
   verify the `scan.quick.v1` metrics move:

   ```sh
   curl -i -X POST http://localhost:8080/api/scan \
     -H 'idempotency-key: migration-scan-001' \
     -H 'content-type: application/json' \
     --data '{"username":"octocat"}'
   curl -s http://localhost:8080/metrics | grep 'kind="scan.quick.v1"'
   curl -s http://localhost:9090/metrics | grep 'kind="scan.quick.v1"'
   ```

   A request that returns `202 Accepted` is not a failed E2E by itself; follow
   its public `Location` (`/api/scan/jobs/{id}`) until `result` is present or
   the status reaches `failed`, then inspect the same metrics and RabbitMQ DLQ.

## Staging environment (verified)

One-command bring-up on any Railway account (Hobby plan or better for
volumes; works on the free trial without them):

```bash
GHFIND_STAGING_LLM_KEY=... \
GHFIND_STAGING_GITHUB_TOKEN=ghp_aaa,ghp_bbb \
GHFIND_STAGING_SITE_URL=https://staging.ghfind.com \
GHFIND_STAGING_MOSOO_TOKEN=... \      # optional; enables the project-analysis lane
GHFIND_STAGING_MOSOO_AGENT_ID=... \   # optional; Mosoo cattle Agent id
./scripts/deploy-staging.sh
```

The script is idempotent and end-to-end: it creates/links the project, adds
the five services, sets every required variable (roles, broker URL, mock
endpoints, machine key, LLM, Mosoo credentials, the analysis reconcile
secret), attaches volumes to RabbitMQ and libsql on plans that support them,
deploys the three source services with an upload retry, creates the public
domains (api :8080, worker metrics :9090, RabbitMQ management :15672), waits
for each deployment to reach SUCCESS, polls both readiness probes until 200,
and prints the smoke-test exports and the Vercel variables for the frontend.
A full cold bring-up takes roughly three minutes on a fresh project.

The backend also serves the project-analysis surface on staging:
`POST /api/project-analyses` (submit a repository), `GET
/api/project-analyses/{id}` (live status/result), `GET /api/project-boards`
(treasure/classic boards), and the secret-authenticated
`/api/internal/project-analyses/reconcile` (re-enqueue stalled runs). The
worker consumes a dedicated `ghfind.project-analysis.v1` queue lane
(`GHFIND_PROJECT_ANALYSIS_CONCURRENCY`, default 3) and drives the Mosoo
agent end to end. Without Mosoo credentials submissions still queue and fail
with the standard `mosoo_*` error codes.

The `ghfind-staging` Railway project runs the full backend topology with mocked
data services so no production Turso/Upstash state is touched:

- `ghfind-api` / `ghfind-worker` / `ghfind-mocks`: source services built from
  `Dockerfile.backend` (final `railway` stage); each selects its binary with
  `GHFIND_ROLE` (`api` / `worker` / `mocks`). `ghfind-mocks` serves the Upstash
  REST mock and idempotently provisions the mock schema into the libsql service.
- `ghfind-libsql`: `ghcr.io/tursodatabase/libsql-server` image, private only,
  standing in for Turso.
- `ghfind-rabbitmq`: `rabbitmq:3.13-management-alpine` image; the management UI
  is exposed on a public domain for operations.

Verified end-to-end on staging (see `docs/releases/deployment-smoke.md` for the
smoke commands and `docs/releases/staging-resilience-evidence.json` for the
captured evidence): async scan admission → real GitHub collection in the worker
→ mock-Turso persistence → public job status/result, RabbitMQ durable topology,
retry evidence (`ghfind_worker_jobs_retried_total > 0` after a forced transient
status-store outage), DLQ evidence (malformed messages rejected into
`ghfind.scan.quick.dead.v1`), active-queue drain, and worker redeploy recovery
(a job admitted before a worker redeploy reaches a terminal state afterwards).

The full three-way separation was verified with a real Vercel frontend
deployment (`ghfind-staging.vercel.app`, server env `GHFIND_BACKEND_ORIGIN`
pointing at the `ghfind-api` public domain, `PUBLIC_SITE_URL` /
`NEXT_PUBLIC_SITE_URL` set to the frontend origin on both sides):
`pnpm smoke:deployment` passes against the frontend origin, covering the `/u/`
profile page, every Go-owned `/api/*` surface through Vercel's transparent
rewrites, MCP `tools/list`, campaign SSE, and public scan job status. Campaign
SSE returns 503 until the campaign has data — seed it once with a
campaign-tagged scan (`POST /api/scan {"username": ..., "campaign": "advx"}`)
so the leaderboard revision record exists.

Scoring-rule parity with production was verified by fresh worker scans compared
against `ghfind.com/api/score/<user>`: all `scoring.*` numeric fields identical
for octocat/torvalds/hikariming (final_score 31.4/94.7/90.6 vs production
31.4/94.7/90.4 — the 0.2 delta on hikariming is GitHub data drift since the
production snapshot, not a rules difference; `sub_scores.contribution_quality`
moved by the same 0.2). Percentile fields differ by design: they rank against
the staging store's population, not production's.

A 52-account influx load test (15 concurrent `POST /api/scan` admissions plus
37 direct broker publishes) drained cleanly through one worker replica at
~2 jobs/30s (GitHub-API-bound, ≈21s average scan): 49 accounts scored, zero
lost messages, transient GitHub GraphQL 502s absorbed by the retry queue, and
the 3 jobs that exhausted `MaxAttempts` during a 502 storm dead-lettered and
completed on re-drive. GitHub Organization accounts (e.g. `backstage`) fail
consistently on both pipelines — production returns 503 `github_unavailable`,
the Go worker retries then dead-letters — so org failure semantics are preserved.

Peak admission is decoupled from scan throughput: a 104-job burst injected in
2.4s (~43 publishes/s through the management API; the broker itself absorbs
far more) was buffered by the durable queue and drained by a single worker
replica in ~7 minutes with 8 concurrent deliveries — ~0.25 jobs/s
vs ~0.043 jobs/s with the original serial consumer, a 5.8x throughput gain
with 8 deliveries in flight at all times. A focused 50-user job-stacking run
(full GitHub re-collection per user) drained in 3.4 minutes; with ~21s per
scan the serial consumer would have needed ~25. A single fresh scan still
completes inside the API's 55s admission wait, so the same-origin
`POST /api/scan` returns the finished result inline — matching the user-facing
latency of the former Next.js pipeline, which ran one scan per serverless
invocation with no queue at all.

Scan concurrency auto-sizes to the GitHub token pool: unset
`GHFIND_SCAN_WORKER_CONCURRENCY` and the worker runs 8 in-flight scans for
one PAT, +4 per additional PAT, capped at 20 — so going from one token to a
five-token comma-separated pool raises throughput from 8 to 20 parallel
scans with no other change. The pool itself round-robins every request and
fails over to the next token on 401/403/429/5xx; a single-token pool still
gets one same-token retry for transient 502s.

Roast generation is not queued: `POST /api/roast` streams from the LLM in the
API handler, so文案 concurrency is bounded by Go's per-request goroutines and
the per-principal rate limits (`rl:roast:m` 8/min), not by the worker. Verified
with 8 parallel fresh generations against StepFun (`step-3.7-flash`): all
streamed full reports in 68s wall time; one stream dropped mid-way on an
upstream wobble and succeeded on retry (mid-stream failures cannot fail over
by design, since bytes were already sent).

The sustained ceiling is GitHub's
per-token quota, not the broker or worker: measured ~7-11 GitHub API calls
per scan against the 5000/h GraphQL allowance gives roughly 450-600 scans/h
per PAT; the comma-separated `GITHUB_TOKEN` pool and additional worker
replicas (competing consumers on the same queue) scale that linearly.

Staging pitfalls learned from bring-up:

- Railway injects `PORT` into every service; `ghfind-mocks` listens on it
  (`:8080`). Never set `PORT` manually on the mocks service, and point
  `UPSTASH_REDIS_REST_URL` at the injected port
  (`http://${{ghfind-mocks.RAILWAY_PRIVATE_DOMAIN}}:8080`). A stale `:8000`
  value caused a readiness outage.
- The RabbitMQ 3.13/4.x management images ship
  `management_agent.disable_metrics_collector = true`, which hides queue
  message/consumer counts from the management API. Set
  `RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS='-rabbitmq_management_agent disable_metrics_collector false'`.
- The free plan allows at most 5 services and no volumes, so a broker restart
  loses in-flight messages and a mocks/libsql restart loses all staged data
  (including scan job status records). Recreate evidence after bouncing mocks.
- Repeated load-test bursts against one PAT can trip GitHub's *secondary* rate
  limit: every scan then fails fast with "GitHub rate limited" while the
  primary `/rate_limit` quota still looks healthy, and the ban lifts after a
  few minutes. It follows the token, not the egress IP. Wait it out (or spread
  bursts across the token pool) before declaring a regression.
- `scripts/deploy-staging.sh` recreates this stack idempotently; pass secrets
  via `GHFIND_STAGING_LLM_KEY` and `GHFIND_STAGING_GITHUB_TOKEN`, and set
  `GHFIND_STAGING_SITE_URL` to the staging frontend origin.
- The staging DB/cache are the in-project libsql server and the Upstash REST
  mock by default. Setting `GHFIND_STAGING_TURSO_URL/TOKEN` and
  `GHFIND_STAGING_UPSTASH_URL/TOKEN` before running `deploy-staging.sh` flips
  the API and worker to the real production Turso/Upstash and skips the mock
  services entirely; mock mode stays the default so a fresh project never
  touches production data. Verified against production: the Go API serves the
  identical score rows/statistics/leaderboards as `ghfind.com` (same
  `scanned_at`), and a worker scan written into the shared store is served
  back by the production Next.js site with the same timestamp.
- Shared-store contract with the Next.js runtime (verified field-by-field
  against `origin/main`): cache versions v9/v10/v4/v1 and every Redis
  key/TTL match; Go omits optional scan-metric keys when unmeasured because
  the Node scorer treats `undefined` and `null` differently (an explicit
  `null` `top_repo_engagement_ratio` would wrongly trigger the 0.5x
  star-engagement penalty), and required arrays always serialize as `[]`.
- Cutover ordering: `blog_comments` is created by the Next.js dev branch's
  `ensureSchema` (the Go backend never creates or migrates schema), so deploy
  the Vercel side before or together with the Go API that serves
  `/api/blog-comments/*`; otherwise those endpoints 503 on a missing table.
- The staging frontend lives at `ghfind-staging.vercel.app` under a personal
  Vercel scope because the team project denied deploy/env permission to the
  operator account. To move it onto `staging.ghfind.com`, deploy the same
  branch from the team project with the same three server envs.

## Production rollout and rollback

### Automated deploy gate (main branch)

`.github/workflows/deploy-production.yml` orchestrates every push to `main`:
Vercel still builds automatically through its GitHub integration, while the
workflow deploys `ghfind-api` and `ghfind-worker` from the same commit with
`railway up`, waits for both platforms, and runs the read-only deployment
smoke against `https://ghfind.com`. If either platform fails — or the smoke
does — the workflow rolls **both** sides back to the anchors captured at the
start of the run: `vercel rollback <previous deployment>` for the frontend,
and an anchor-deployment redeploy (fallback: rebuild of the previous main
commit) for the Railway services.

Required GitHub secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID` (team-scoped Vercel token) and `RAILWAY_TOKEN` (Railway
project token bound to the backend project and its production environment).
The gate logic lives in `.github/scripts/deploy-gate.mjs`; step state is kept
in a workspace-local `.deploy-gate-state.json` that never leaves the runner.

Environment-variable safety: the workflow never mutates Railway variables.
They live on the service/environment layer, so redeploys and rollbacks keep
them and fresh rebuilds inherit them. Operator snapshots of every service's
variables and the deployment anchors are kept outside the repository under
`~/.ghfind-ops/backups/` (local operator machine) as disaster recovery.

### Manual rollout checklist

1. The selected production target is **Railway**. Create three persistent
   Railway services: `ghfind-api`, `ghfind-worker`, and private `ghfind-rabbitmq`.
   Attach the API and worker to the same repository/branch and set
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.backend` on both. The API uses the
   default `/ghfind-api` entrypoint and listens on Railway's injected `PORT`;
   set the worker service Start Command to `/ghfind-worker`. Give RabbitMQ no
   public domain or public management port.
   Point each Railway healthcheck at its liveness path (`/healthz` on
   `:8080` for the API, on `:9090` for the worker) with a readiness pass on
   `/readyz`; the worker's readiness probe covers the broker link, so Railway
   can restart a worker whose RabbitMQ connection died.
   Attach a Railway persistent volume to RabbitMQ at `/var/lib/rabbitmq`; durable
   queues only survive a broker restart when its message store does. Configure
   identical Turso/Upstash/RabbitMQ secrets on API and worker, then deploy the
   worker separately from the API. Do not create a second VPS or Kubernetes
   production path for this rollout.
2. Restrict direct API access to Vercel/operations traffic where the host
   permits it. The Go API ignores generic `X-Forwarded-For`; only set
   `GHFIND_TRUST_VERCEL_HEADERS=1` after the Railway service is not directly
   reachable by arbitrary clients, so rate-limit identity can safely use
   Vercel's platform-injected `X-Vercel-Forwarded-For`.
3. Confirm `/healthz`, `/readyz`, broker queue depth, DLQ depth, job failure
   count and job processing latency before setting `GHFIND_BACKEND_ORIGIN`.
   Confirm the worker's own `/healthz` and `/readyz` on the metrics listener
   (`:9090` by default, `GHFIND_WORKER_METRICS_LISTEN_ADDR`): the ready probe
   checks Turso, Upstash and RabbitMQ, so a broken dependency prevents the
   platform from treating the worker as healthy. Configure Railway healthchecks
   on both services (the image also ships Docker `HEALTHCHECK` stanzas using
   the distroless-safe `/ghfind-healthcheck` binary). Scrape API `/metrics` and
   worker `/metrics` from Railway private networking or an operator tunnel.
   Alert at minimum on non-zero publish failures, increasing
   `ghfind_worker_jobs_failed_total`, DLQ depth, and sustained scan duration
   growth. `docs/operations/backend-alerts.prometheus.yml` contains a concrete
   Prometheus rule set for those process metrics plus RabbitMQ exporter
   queue-depth metrics.
4. Set that Vercel server variable and deploy Vercel. Do not set
   `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_SECRET`, Turso, Upstash,
   GitHub PAT, RabbitMQ, Turnstile secret or LLM provider secrets in Vercel.
   Exercise the same-origin `https://ghfind.com/api/stats` request and the authenticated job flow.
   For the verdict gateway, also set the same `GHFIND_VERDICT_GATEWAY_SECRET`
   in Vercel and API, then exercise `POST https://ghfind.com/api/vs-verdict`.
5. Run the read-only deployment smoke before promotion. For a backend cutover,
   require a known public scan job and direct private process metrics:

   ```sh
   SMOKE_BASE_URL=https://staging.ghfind.com \
   SMOKE_CANARY_HANDLE=octocat \
   SMOKE_FACET_TYPE=language \
   SMOKE_FACET_VALUE=TypeScript \
   SMOKE_SCAN_JOB_ID=job_... \
   SMOKE_SCAN_JOB_USERNAME=octocat \
   SMOKE_SCAN_JOB_EXPECT_RESULT=1 \
   SMOKE_REQUIRE_SCAN_JOB=1 \
   SMOKE_BACKEND_BASE_URL=https://ghfind-api-staging.example.com \
   SMOKE_WORKER_METRICS_BASE_URL=https://ghfind-worker-metrics-staging.example.com \
   pnpm smoke:deployment
   ```

   The smoke is deliberately read-only: it checks same-origin pages/API, MCP,
   campaign SSE, public scan status/result, API health/readiness/metrics and
   worker metrics without starting a new scan or roast.
6. Run the write-path async staging smoke once on a cold canary handle. This is
   the reproducible proof of `same-origin API -> RabbitMQ -> independent worker
   -> Turso/Upstash result -> public status`:

   ```sh
   SMOKE_BASE_URL=https://staging.ghfind.com \
   SMOKE_SCAN_USERNAME=... \
   SMOKE_MACHINE_API_KEY=... \
   SMOKE_BACKEND_BASE_URL=https://ghfind-api-staging.example.com \
   SMOKE_WORKER_METRICS_BASE_URL=https://ghfind-worker-metrics-staging.example.com \
   pnpm smoke:backend:async
   ```

   The script uses a machine-authenticated scan so no Turnstile secret is ever
   exposed to the runner. It fails on cached scans by default; use a cold canary
   for promotion evidence.
7. Record rollback anchors before promotion: the previous healthy Vercel
   deployment URL, the previous healthy Railway deployment IDs for `ghfind-api`
   and `ghfind-worker`, the current `GHFIND_BACKEND_ORIGIN`, and RabbitMQ queue
   depths for `ghfind.scan.quick.v1`, `ghfind.scan.quick.retry.v1`,
   `ghfind.score-snapshot.v1`, and their DLQs.
8. Collect the resilience evidence bundle from a private staging runner or
   operator tunnel:

   ```sh
   SMOKE_BASE_URL=https://staging.ghfind.com \
   SMOKE_BACKEND_BASE_URL=https://ghfind-api-staging.example.com \
   SMOKE_WORKER_METRICS_BASE_URL=https://ghfind-worker-metrics-staging.example.com \
   SMOKE_RABBITMQ_MANAGEMENT_URL=https://rabbitmq-management-tunnel.example.com \
   SMOKE_RABBITMQ_MANAGEMENT_USER=... \
   SMOKE_RABBITMQ_MANAGEMENT_PASSWORD=... \
   SMOKE_REQUIRE_DEPLOYMENT_ANCHORS=1 \
   SMOKE_VERCEL_DEPLOYMENT_ID=... \
   SMOKE_RAILWAY_API_DEPLOYMENT_ID=... \
   SMOKE_RAILWAY_WORKER_DEPLOYMENT_ID=... \
   SMOKE_RABBITMQ_VOLUME_ID=... \
   SMOKE_REQUIRE_RETRY_EVIDENCE=1 \
   SMOKE_REQUIRE_DLQ_EVIDENCE=1 \
   SMOKE_REQUIRE_EMPTY_ACTIVE_QUEUES=1 \
   SMOKE_REQUIRE_RESTART_EVIDENCE=1 \
   SMOKE_RESTART_JOB_ID=job_... \
   SMOKE_RESTART_EXPECT_RESULT=1 \
   SMOKE_WORKER_DEPLOYMENT_BEFORE=... \
   SMOKE_WORKER_DEPLOYMENT_AFTER=... \
   SMOKE_EVIDENCE_OUTPUT=artifacts/backend-resilience-evidence.json \
   pnpm smoke:backend:resilience
   ```

   Run this after a forced transient retry, after a forced terminal scan
   failure, and after an API/worker restart. The script validates durable queue
   declarations, DLQ wiring, metrics, drained active queues, and the terminal
   public scan status used as restart-recovery proof.

## Rollback playbook

### Shared-store version contract (verified)

Both runtimes read and write the same Turso/Upstash stores under one version
contract, and a rollback never changes schema or key names:

- `config/release-versions.json` is byte-identical with `main` (md5
  6779b27c…). Canonical: score `v9`, roast `v10`, collection `v4`; read order
  `["v9"]`; legacy fallback `v5/v5/v3` is historical only — neither runtime
  queries it today.
- Go writes `scores.score_version=v9`,
  `score_source_collection_version=v4`, roast artifacts at `v10`, and reads
  only `v9`/`v4` rows — the same filters `main` uses — so either runtime can
  serve data written by the other. Cache keys are version-pinned on both
  sides (`scan:v4:`, `roast:v10:v9:v4:`, `verdict:v1:`), and Go omits
  unmeasured metric keys because the Node scorer treats `undefined` and
  `null` differently.
- A version bump is a three-way coordinated change:
  `release-versions.json`, the Next constants (`src/lib/cache-version.ts`),
  and the Go constants (`goCanonicalScoreVersion` /
  `goCanonicalCollectionVersion` in `scan_persistence.go`,
  `roastArtifactVersion` in `roast_store.go`). The contract's change control
  allows one component per pull request.
- Queue state is not versioned and does not roll back with code: jobs
  admitted to RabbitMQ during the cutover window (`scan.quick.v1`,
  `score_snapshot.v1`, `project-analysis.v1`) are only visible to the Go
  worker. Drain or explicitly discard them before a Vercel rollback (mode
  2/3); `project_analysis_runs` rows in non-terminal states can be re-driven
  later via the internal reconcile endpoint once a compatible worker is back.

### Modes

There are three rollback modes. Pick exactly one based on the failed layer.

1. **Go release rollback**: if Vercel rewrites are healthy but the new API or
   worker revision is bad, roll the `ghfind-api` and/or `ghfind-worker` Railway
   service back to the previous healthy deployment. Keep `GHFIND_BACKEND_ORIGIN`
   unchanged, wait for `/readyz`, then run:

   ```sh
   SMOKE_BASE_URL=https://staging.ghfind.com \
   SMOKE_CANARY_HANDLE=octocat \
   SMOKE_FACET_TYPE=language \
   SMOKE_FACET_VALUE=TypeScript \
   SMOKE_SCAN_JOB_ID=job_... \
   SMOKE_SCAN_JOB_USERNAME=octocat \
   SMOKE_SCAN_JOB_EXPECT_RESULT=1 \
   SMOKE_REQUIRE_SCAN_JOB=1 \
   SMOKE_BACKEND_BASE_URL=https://ghfind-api-staging.example.com \
   SMOKE_WORKER_METRICS_BASE_URL=https://ghfind-worker-metrics-staging.example.com \
   pnpm smoke:deployment
   ```

   If the worker was rolled back, also run `pnpm smoke:backend:async` on a cold
   canary to prove the queue consumer still persists new work. Then run
   `pnpm smoke:backend:resilience` with `SMOKE_REQUIRE_ROLLBACK_EVIDENCE=1`,
   `SMOKE_ROLLBACK_MODE=railway`, and the from/to Railway deployment IDs.
2. **Vercel release rollback**: if the new Vercel deployment, rewrites, cookies
   or static/rendering behavior is bad, use Vercel's deployment rollback to move
   the production alias back to the saved previous healthy deployment. This is
   the only functional frontend rollback once the new deployment contains
   fail-closed API guards instead of the old business handlers. After the alias
   move, run the read-only deployment smoke against the public origin.
3. **Emergency fail-closed containment**: unsetting `GHFIND_BACKEND_ORIGIN` and
   redeploying the extracted frontend intentionally returns `503
   backend_not_configured` for Go-owned API routes. This stops Vercel from
   handling secrets or spending GitHub/LLM/Turso/Redis budget, but it is not a
   functional rollback and does not satisfy the issue's rollback verification.
   Use it only when both Go and previous Vercel rollback targets are unavailable.

In all modes, do not touch Turso schema/data or Upstash key names. Keep the API
and worker running until RabbitMQ queue depth reaches zero, or explicitly purge
only queues from the rolled-back cutover window after confirming no job result
is still needed. A rollback is verified only after smoke passes, queue/DLQ
depths are recorded, and the operator confirms no stuck `scan.quick.v1`,
`score_snapshot.v1` or `project-analysis.v1` job remains in a non-terminal
state (including `project_analysis_runs` rows not in
`completed/failed/cancelled/expired`).

This is an incremental migration runbook. Every additional API route must add
its contract fixture, Go owner and same-origin rewrite before its Next business
implementation is removed.
