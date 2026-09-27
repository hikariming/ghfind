# Cloudflare deployment smoke

The current production topology is one OpenNext Cloudflare Worker: the same
origin serves the UI and all `/api/*` routes. This document describes the
read-only release smoke for `ghfind-dev` and `ghfind`; it no longer assumes a
Vercel frontend, Railway API, or a separate metrics origin.

`scripts/smoke-deployment.mts` is read-only. It never starts a scan or roast and
does not print canary handles, run IDs, response bodies, or credentials.

Configure these values privately in the deployment system. Use
`https://dev.ghfind.com` for dev or `https://ghfind.com` for production:

```text
SMOKE_BASE_URL
SMOKE_CANARY_HANDLE
SMOKE_FACET_TYPE
SMOKE_FACET_VALUE
```

To optionally verify a previously admitted public scan job without starting new
GitHub work, configure:

```text
SMOKE_SCAN_JOB_ID
SMOKE_SCAN_JOB_USERNAME
SMOKE_SCAN_JOB_EXPECT_RESULT=1
SMOKE_REQUIRE_SCAN_JOB=1
```

The current single-Worker smoke does not require separate backend or worker
metrics origins. `SMOKE_BACKEND_BASE_URL` and
`SMOKE_WORKER_METRICS_BASE_URL`, if present in an old runner, are legacy
split-backend checks and should be removed from the Cloudflare release job.

Use `SMOKE_ALLOW_HTTP=1` only for local smoke runs. Remote origins must be HTTPS.

For dev, the zone's ASN challenge can block runner egress on the custom domain,
so run against the WAF-free workers.dev entrance and pin the canonical origin
the score API is expected to report:

```text
SMOKE_BASE_URL=https://ghfind-dev.beiming1201.workers.dev
SMOKE_EXPECTED_ORIGIN=https://dev.ghfind.com
```

`SMOKE_EXPECTED_ORIGIN` defaults to the `SMOKE_BASE_URL` origin when unset.


Run `pnpm smoke:deployment`. The script checks the profile, deterministic score
API, badge SVG, autocomplete, score leaderboard,
facet bucket, projects page, sitemap XML, MCP tools/list transport, campaign
SSE reconnect frame, optional public scan status/result, and canonical origin.
Missing required values, `localhost` canonical output on a remote smoke,
unexpected status, or malformed response content fails the run.

Run `pnpm smoke:deployment:selftest` to exercise every smoke branch against a
 local fixture server. CI runs this self-test without production secrets; a
 release must still run the real smoke against the deployed Cloudflare Worker
 origin.

Before promoting a Cloudflare production deployment, set both
`NEXT_PUBLIC_SITE_URL` and `PUBLIC_SITE_URL` to the same HTTPS origin. The build
rejects missing, local, HTTP, malformed, or mismatched production values.
Use an explicit local origin only in local development or Preview; never copy
the value or unrelated environment settings into logs, issues, or screenshots.

## Historical split-backend smoke

The `smoke:backend:*` scripts, rollback verification and resilience evidence for
the retired Go API/worker plus Railway topology were removed with that backend
(score v11 cutover); see git history before `feat/devscore-score-v11`.
