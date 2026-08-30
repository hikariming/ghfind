# Cloudflare Worker deployment smoke

`scripts/smoke-deployment.mts` is the read-only production acceptance check for
the OpenNext Worker. It does not start a scan, generate a roast, write to D1,
or print response bodies, identifiers, or credentials.

Configure the following non-secret values in the GitHub `production`
environment (or export them from a private operator shell):

```text
SMOKE_BASE_URL=https://ghfind.com
SMOKE_CANARY_HANDLE
SMOKE_FACET_TYPE=language|org|repo
SMOKE_FACET_VALUE
SMOKE_CAMPAIGN                 # optional; defaults to advx
```

Run:

```sh
pnpm smoke:deployment
```

The smoke verifies the rendered profile, score and canonical URL, search,
leaderboard, developer facet, statistics, OpenAPI document, SVG badge, sitemap,
agent instructions, MCP `tools/list`, and campaign SSE reconnect frame. These are the public
contracts served by the Worker. It deliberately does not test the retired
Go/Railway process health, RabbitMQ queues, `/api/scan/jobs/*`, or the removed
`/api/profile`, `/api/embed/badge`, `/api/projects`, and `/api/sitemap` routes.

Use `SMOKE_ALLOW_HTTP=1` only for the fixture self-test or a local Worker. Any
remote smoke origin must be HTTPS. The self-test exercises every smoke branch
without production configuration:

```sh
pnpm smoke:deployment:selftest
```

## Deploy and rollback

`pnpm cf:deploy:prod` builds the OpenNext Worker, deploys the `production`
environment in `wrangler.jsonc`, and populates the R2 incremental cache. The
production GitHub workflow runs that command on every `main` push and then runs
the smoke.

If a deployed version must be reverted, identify the previously healthy Worker
version and roll back explicitly, then run the same smoke:

```sh
pnpm exec wrangler deployments list --env production
pnpm exec wrangler rollback <healthy-version-id> --env production --yes \
  --message "rollback: <incident-or-commit>"
SMOKE_BASE_URL=https://ghfind.com \
  SMOKE_CANARY_HANDLE=<handle> \
  SMOKE_FACET_TYPE=language \
  SMOKE_FACET_VALUE=TypeScript \
  pnpm smoke:deployment
```

Never use a DNS switch to Vercel or a Railway redeploy as a production rollback:
the supported production artifact is the Cloudflare Worker version.
