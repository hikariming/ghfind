# Deployment smoke

`scripts/smoke-deployment.mts` is read-only. It never starts a scan or roast and
does not print canary handles, run IDs, response bodies, or credentials.

Configure these values privately in the deployment system:

```text
SMOKE_BASE_URL
SMOKE_CANARY_HANDLE
SMOKE_FACET_TYPE
SMOKE_FACET_VALUE
SMOKE_COMPLETE_HANDLE
SMOKE_COMPLETE_RUN_ID
```

An active pending-run check is optional because a pending run eventually becomes
complete. To require it for a controlled promotion window, also configure:

```text
SMOKE_PENDING_HANDLE
SMOKE_PENDING_RUN_ID
SMOKE_REQUIRE_PENDING=1
```

Run `pnpm smoke:deployment`. The script checks the profile, deterministic score
API, autocomplete, score leaderboard, facet bucket, complete scan status,
optional pending scan status, and canonical origin. Missing required values,
`localhost` canonical output, unexpected status, or malformed JSON fails the run.

Before promoting a Vercel deployment, set both `NEXT_PUBLIC_SITE_URL` and
`PUBLIC_SITE_URL` to the same HTTPS origin in the Production environment. The
build rejects missing, local, HTTP, malformed, or mismatched production values.
Use an explicit local origin only in local development or Preview; never copy
the value or unrelated environment settings into logs, issues, or screenshots.
