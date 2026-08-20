# Deployment smoke

`scripts/smoke-deployment.mts` is read-only. It never starts a scan or roast and
does not print canary handles, run IDs, response bodies, or credentials.

Configure these values privately in the deployment system:

```text
SMOKE_BASE_URL
SMOKE_CANARY_HANDLE
SMOKE_FACET_TYPE
SMOKE_FACET_VALUE
```

For the Go backend cutover, also configure a previously admitted public scan job
so the smoke can prove the `202 -> Location -> result` path without starting new
GitHub work:

```text
SMOKE_SCAN_JOB_ID
SMOKE_SCAN_JOB_USERNAME
SMOKE_SCAN_JOB_EXPECT_RESULT=1
SMOKE_REQUIRE_SCAN_JOB=1
```

To prove process-level Railway health and metrics, configure private origins
reachable only from the deployment runner, Railway private networking, or an SSH
tunnel:

```text
SMOKE_BACKEND_BASE_URL
SMOKE_WORKER_METRICS_BASE_URL
```

Use `SMOKE_ALLOW_HTTP=1` only for local or tunneled localhost smoke runs. Remote
origins must be HTTPS.

If the production Vercel project has Deployment Protection, configure its
Protection Bypass for Automation secret. The main deployment gate downloads
the production system environment for the smoke command with `vercel env run`
and supplies
`VERCEL_AUTOMATION_BYPASS_SECRET` only as
`x-vercel-protection-bypass` on requests to the Vercel origin. It is never sent
to direct Railway API/worker origins. A missing secret fails the production
smoke instead of treating Vercel's challenge response as an application error.

Run `pnpm smoke:deployment`. The script checks the profile, deterministic score
API, Go-owned profile presentation, badge embed data, autocomplete, score
leaderboard, facet bucket, project list, sitemap inventory, MCP tools/list
transport, campaign SSE reconnect frame, optional public scan status/result,
optional Go API `/healthz` `/readyz` `/metrics`, optional worker `/metrics`,
and canonical origin. Missing required values, `localhost` canonical output on
a remote smoke, unexpected status, or malformed JSON fails the run.

Run `pnpm smoke:deployment:selftest` to exercise every smoke branch against a
local fixture server. CI runs this self-test without production secrets; staging
must still run the real smoke against the deployed Vercel/Railway origins.
The fixture also fails if the bypass header is absent on public requests or is
leaked to a direct backend request.

## Backend async smoke

`scripts/smoke-backend-async.mts` is the write-path staging E2E for issue #170.
It starts one real same-origin `POST /api/scan` using machine authentication,
polls the deterministic public job status, and checks direct API/worker metrics.
It fails if the scan was served from cache unless `SMOKE_ALLOW_CACHED_SCAN=1`
is explicitly set, because a cached response does not prove queue admission or
worker execution.

Configure these values only in a private staging runner:

```text
SMOKE_BASE_URL=https://staging.ghfind.com
SMOKE_SCAN_USERNAME=...
SMOKE_MACHINE_API_KEY=...
SMOKE_BACKEND_BASE_URL=https://ghfind-api-staging.example.com
SMOKE_WORKER_METRICS_BASE_URL=https://ghfind-worker-metrics-staging.example.com
```

Optional:

```text
SMOKE_IDEMPOTENCY_KEY=staging-cutover-001
SMOKE_ALLOW_CACHED_SCAN=1
```

Run `pnpm smoke:backend:async`. The script does not print the handle, API key,
job payload or response bodies. Run `pnpm smoke:backend:async:selftest` to
exercise the control flow locally without secrets.

## Rollback verification

Use the same smoke commands after a rollback, but record which rollback mode was
used:

- Railway API/worker rollback: run `pnpm smoke:deployment` and, if the worker
  changed, `pnpm smoke:backend:async` against a cold canary.
- Vercel deployment rollback: move the production alias back to the saved
  previous healthy Vercel deployment, then run `pnpm smoke:deployment`.
- Emergency `GHFIND_BACKEND_ORIGIN` removal: this is fail-closed containment,
  not a functional rollback. Go-owned routes return `503 backend_not_configured`
  by design and this state must not be used as issue-completion evidence.

Attach the smoke command, timestamp, deployment IDs, and queue/DLQ depth snapshot
to the staging evidence bundle. Install or adapt
`docs/operations/backend-alerts.prometheus.yml` before promotion so publish
failures, worker failures, dead-lettering, latency growth, scan backlog and DLQ
depth have explicit alerts.

## Backend resilience evidence

`scripts/smoke-backend-resilience.mts` collects the evidence that the normal
async smoke deliberately does not mutate: Railway deployment anchors, API and
worker metrics, RabbitMQ durable queue topology, queue/DLQ depths, optional
restart recovery, optional retry/DLQ proof, and optional rollback anchors. It
does not publish a job or print credentials.

Configure these private values from a staging runner, Railway private
networking, or an operator tunnel:

```text
SMOKE_BACKEND_BASE_URL=https://ghfind-api-staging.example.com
SMOKE_WORKER_METRICS_BASE_URL=https://ghfind-worker-metrics-staging.example.com
SMOKE_RABBITMQ_MANAGEMENT_URL=https://rabbitmq-management-tunnel.example.com
SMOKE_RABBITMQ_MANAGEMENT_USER=...
SMOKE_RABBITMQ_MANAGEMENT_PASSWORD=...
SMOKE_EVIDENCE_OUTPUT=artifacts/backend-resilience-evidence.json
```

For issue #170 completion evidence, run it after the async smoke, after a
forced transient retry, after a forced terminal failure, and after an
API/worker restart or rollback exercise:

```text
SMOKE_BASE_URL=https://staging.ghfind.com
SMOKE_REQUIRE_DEPLOYMENT_ANCHORS=1
SMOKE_VERCEL_DEPLOYMENT_ID=...
SMOKE_RAILWAY_API_DEPLOYMENT_ID=...
SMOKE_RAILWAY_WORKER_DEPLOYMENT_ID=...
SMOKE_RABBITMQ_VOLUME_ID=...
SMOKE_REQUIRE_RETRY_EVIDENCE=1
SMOKE_REQUIRE_DLQ_EVIDENCE=1
SMOKE_REQUIRE_EMPTY_ACTIVE_QUEUES=1
SMOKE_REQUIRE_RESTART_EVIDENCE=1
SMOKE_RESTART_JOB_ID=job_...
SMOKE_RESTART_EXPECT_RESULT=1
SMOKE_WORKER_DEPLOYMENT_BEFORE=...
SMOKE_WORKER_DEPLOYMENT_AFTER=...
SMOKE_REQUIRE_ROLLBACK_EVIDENCE=1
SMOKE_ROLLBACK_MODE=railway
SMOKE_ROLLBACK_FROM_DEPLOYMENT_ID=...
SMOKE_ROLLBACK_TO_DEPLOYMENT_ID=...
SMOKE_ROLLBACK_VERIFIED_AT=...
```

Run `pnpm smoke:backend:resilience`. Run
`pnpm smoke:backend:resilience:selftest` to exercise all checks against local
fixtures without secrets. A passing self-test is not staging proof; the real
run must attach the generated evidence JSON plus the read-only deployment smoke
and write-path async smoke output.

Before promoting a Vercel deployment, set both `NEXT_PUBLIC_SITE_URL` and
`PUBLIC_SITE_URL` to the same HTTPS origin in the Production environment. The
build rejects missing, local, HTTP, malformed, or mismatched production values.
Use an explicit local origin only in local development or Preview; never copy
the value or unrelated environment settings into logs, issues, or screenshots.
