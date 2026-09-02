# Cloudflare deployment runbook

This is the current release and rollback guide for GitHub Roast.

## Current topology

The frontend and backend are deployed together as one Next-on-Workers application
through `@opennextjs/cloudflare`:

| Environment | Worker | Public origin | Cloudflare resources |
| --- | --- | --- | --- |
| dev | `ghfind-dev` | `https://dev.ghfind.com` | D1 binding `GHFIND_D1`, R2 `ghfind-next-cache-dev` |
| production | `ghfind` | `https://ghfind.com` | D1 binding `GHFIND_D1`, R2 `ghfind-next-cache` |

There is no Vercel frontend, Railway API, `GHFIND_BACKEND_ORIGIN`, or same-origin
backend rewrite in the current production path. Browser and machine clients call
the same Worker origin. Upstash Redis, GitHub, LLM providers, and Mosoo remain
external services reached by the Worker through server-side secrets.

The authoritative deployment files are:

- [`wrangler.jsonc`](../../wrangler.jsonc) — Worker environments and D1/R2 bindings.
- [`package.json`](../../package.json) — build and deploy scripts.
- [`.github/workflows/deploy-cf-production.yml`](../../.github/workflows/deploy-cf-production.yml) — CI-gated production release and automatic Worker rollback.
- [`scripts/smoke-deployment.mts`](../../scripts/smoke-deployment.mts) — read-only public smoke checks.

Production ownership is fixed: `ghfind` must be deployed to
`Beiming1201@gmail.com's Account` (`8f19bebe359e4ec1a24c68c5f49c1584`). The
repository config and production workflow pin this account. The
`AsperforMias` account is not a production target and must not be used for
production Workers, D1, R2, or Secrets.

## Hard stop: preflight the target account and resources

Run these checks from the repository root before a remote deployment:

```bash
pnpm exec wrangler whoami
pnpm exec wrangler d1 list
pnpm exec wrangler d1 info ghfind
pnpm exec wrangler r2 bucket list
pnpm exec wrangler secret list --env dev
pnpm exec wrangler secret list --env production
```

For production, the account check is mandatory:

```bash
test "${CLOUDFLARE_ACCOUNT_ID:-8f19bebe359e4ec1a24c68c5f49c1584}" = "8f19bebe359e4ec1a24c68c5f49c1584"
```

Confirm all of the following before continuing:

1. The account that owns the configured D1 database is the account Wrangler will
   deploy to. Compare the `database_id` in `wrangler.jsonc` with `wrangler d1
   list`/`wrangler d1 info ghfind`; do not create an empty replacement database
   merely to make deployment pass.
2. `ghfind-next-cache-dev` and `ghfind-next-cache` exist in the same account.
3. Required secrets exist in the target environment. `secret list` exposes names,
   not values; never paste secret values into a command, log, issue, or screenshot.
4. The production values of `PUBLIC_SITE_URL` and `NEXT_PUBLIC_SITE_URL` are both
   `https://ghfind.com`. The dev values are both `https://dev.ghfind.com`.

If the OAuth session can access multiple Cloudflare accounts, the production
commands in this repository force `CLOUDFLARE_ACCOUNT_ID` to the Beiming account.
Do not replace it with an `AsperforMias` account ID and do not deploy until the
D1 and R2 inventory is visible in Beiming.

For a local release, the explicit form is:

```bash
export CLOUDFLARE_ACCOUNT_ID=<target-account-id>
export CLOUDFLARE_ACCOUNT_ID=8f19bebe359e4ec1a24c68c5f49c1584
pnpm exec wrangler d1 list
pnpm exec wrangler r2 bucket list
```

### Important dev-data warning

At the time of writing, `wrangler.jsonc` gives both `dev` and `production` the same
`GHFIND_D1` database ID. The R2 cache buckets are separate, but the D1 data is not.
Until a separate staging D1 is deliberately created and configured, treat dev as
a production-data environment: do not run write-path scan/roast or destructive
SQL smoke tests against `dev.ghfind.com`.

## Secrets

Set secrets interactively for each Worker environment. Never commit a secret file:

```bash
pnpm exec wrangler secret put GITHUB_TOKEN --env production
pnpm exec wrangler secret put LLM_API_KEY --env production
pnpm exec wrangler secret put UPSTASH_REDIS_REST_URL --env production
pnpm exec wrangler secret put UPSTASH_REDIS_REST_TOKEN --env production
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY --env production
pnpm exec wrangler secret put AUTH_GITHUB_ID --env production
pnpm exec wrangler secret put AUTH_GITHUB_SECRET --env production
pnpm exec wrangler secret put AUTH_SECRET --env production
pnpm exec wrangler secret put ADMIN_SECRET --env production
```

Add the optional fallback LLM, Mosoo, CLI, Resend, and project-analysis secrets
when those features are enabled. Repeat the required set for `--env dev` only if
the dev Worker is intended to be used; do not copy production OAuth or write-path
credentials into dev without an explicit data-safety decision.

`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_SITE_URL`, and
`NEXT_PUBLIC_SITE_URL` are non-secret build/runtime variables. The first is set in
the deployment environment; the latter two are already defined per environment in
`wrangler.jsonc` and must remain equal to the public origin.

## Validate without changing Cloudflare

Build and validate the Worker bundle before publishing it:

```bash
pnpm cf:build
pnpm exec wrangler deploy --env dev --dry-run
pnpm exec wrangler deploy --env production --dry-run
```

`--dry-run` is a validation step only. It must not be treated as proof that the
remote account has the configured D1/R2 resources; the preflight above is still
required.

## Deploy dev

Only deploy dev after the resource preflight and the D1 data-safety warning have
been acknowledged:

```bash
pnpm cf:deploy:dev
```

The script builds OpenNext, deploys `ghfind-dev`, and populates the remote R2
incremental cache. Use this repository script as the release command so the
cache-population step is explicit and remains coupled to the Worker deployment.

## Deploy production

The normal local/manual release command is:

```bash
pnpm cf:deploy:prod
```

The repository script pins the Beiming account and deploys with `--keep-vars`,
preserving dashboard variables; Worker Secrets are not removed by a code
deployment. CI supplies `CLOUDFLARE_API_TOKEN`; the token must have permission
to deploy Workers and access the configured D1/R2 resources.

The automatic production workflow is triggered by a successful `CI` workflow
completion on `main`, not by a raw push. It checks out the exact commit SHA that
CI verified, captures the active 100% Worker version, deploys, and runs the
read-only production smoke three times at most. A build, deployment, or smoke
failure invokes `wrangler rollback` to restore the captured version, then runs
the smoke again against the restored origin. Because the current frontend and
backend are one Worker, this is a single atomic application rollback for both.

Protect `main` in GitHub and require the `CI / Verify release` check before
merging. The workflow-level gate prevents a failed CI run from deploying even
if an administrator bypasses branch protection; branch protection is still
needed to enforce merge-only changes.

Before a production release, record the current active deployment and run the
local checks required by CI:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm cf:build
```

If `migrations/` changed, review and apply the migration to the intended remote
D1 before publishing the Worker:

```bash
pnpm exec wrangler d1 migrations list ghfind --remote --env production
pnpm exec wrangler d1 migrations apply ghfind --remote --env production
```

Run this only after the account/database preflight. A Worker-version rollback does
not undo an applied D1 migration; schema changes need a separately reviewed
forward-fix or data recovery plan.

## Post-deploy smoke

The smoke is read-only and exercises the public Worker origin. It does not start a
scan or roast. Configure the values privately in the shell or deployment runner:

```bash
export SMOKE_BASE_URL=https://dev.ghfind.com
export SMOKE_CANARY_HANDLE=octocat
export SMOKE_FACET_TYPE=language
export SMOKE_FACET_VALUE=JavaScript
pnpm smoke:deployment
```

For production, change only `SMOKE_BASE_URL` to `https://ghfind.com` and use a
known indexed canary/facet value. The smoke covers profile, score, profile data,
badge, autocomplete, leaderboard, developer facets, projects, sitemap inventory,
MCP `tools/list`, and campaign SSE. If a previously admitted scan job is available,
set `SMOKE_SCAN_JOB_ID`, `SMOKE_SCAN_JOB_USERNAME`, and
`SMOKE_SCAN_JOB_EXPECT_RESULT=1` to verify its public result path.

For the rate-limit incident, add a manual browser check after the read-only smoke:

1. Open the public site in a normal browser and submit one roast.
2. Confirm the browser `/api/roast` request is not rejected by the machine-only
   authentication path or a global edge rule.
3. Confirm repeated requests use the expected cached/reuse path and that a true
   machine request still receives the intended authentication/rate-limit response.
4. If behavior is unclear, inspect the Worker with `pnpm exec wrangler tail ghfind`
   or the Workers Logs dashboard; never log request bodies, API keys, or cookies.

The `smoke:backend:*` scripts and the old Railway/Vercel resilience evidence are
historical tests for the retired split backend topology. They are not the current
production release gate.

## Automated rollback

The production workflow records the active Worker version before publishing.
If build/deploy/post-deploy smoke fails, it automatically runs:

```bash
pnpm exec wrangler rollback <CAPTURED_VERSION_ID> --name ghfind --env production --message "rollback: post-deploy verification failed" --yes
```

It then repeats the read-only smoke. A failed rollback verification keeps the
GitHub Actions run failed and requires operator intervention.

## Manual rollback

Cloudflare rollback is a Worker-version rollback; DNS does not need to be changed
back to Vercel:

```bash
pnpm exec wrangler deployments list --name ghfind
pnpm exec wrangler rollback <VERSION_ID> --name ghfind --message "rollback: <reason>"
```

`wrangler rollback` immediately makes the selected version active across the
Worker's routes and domains. Verify the public origin with the same smoke command
after rollback. A code rollback does not undo D1 schema/data changes, R2 objects,
Redis keys, or external-provider side effects; those require a separate, reviewed
recovery operation.

For dev, use the same commands with `--name ghfind-dev`. Do not delete the Worker,
custom domain, D1 database, or R2 bucket as an incident response shortcut.

## Release evidence

Record the following for every production release or rollback:

- git commit and Cloudflare Worker deployment/version ID;
- target account ID and confirmation that D1/R2 preflight passed;
- smoke command, origin, timestamp, and result;
- any changed D1 migration, secret name, WAF rule, or cache action;
- rollback target and the post-rollback smoke result, if rollback occurred.
