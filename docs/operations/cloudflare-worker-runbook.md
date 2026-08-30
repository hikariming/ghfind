# Cloudflare Worker runbook

## Source of truth

`wrangler.jsonc` defines the `ghfind` production Worker, the `ghfind-dev`
development Worker, the `GHFIND_D1` binding, and the R2 incremental-cache
buckets. Application routes execute in the OpenNext Worker; no request is
rewritten to Vercel, Railway, RabbitMQ, or a separate Go process.

Before any operator action, confirm that the active Wrangler identity can see
the owning account and Worker:

```sh
pnpm exec wrangler whoami
pnpm exec wrangler deployments list --env production
```

If the deployment command reports that `ghfind` does not exist, stop. Switch to
the Cloudflare account/profile that owns the Worker instead of creating a new
Worker in the current account.

## Configuration

Worker secrets are environment-scoped and must be set outside git:

```sh
pnpm exec wrangler secret put <NAME> --env production
pnpm exec wrangler secret put <NAME> --env dev
```

Use [`.env.example`](../../.env.example) as the list of application settings;
`wrangler secret list --env <environment>` can confirm names without exposing
values. The production and development D1/R2 bindings are already declared in
`wrangler.jsonc`; do not recreate, rename, or delete them during a code deploy.

The GitHub `production` environment needs these secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The token must belong to the account that owns `ghfind` and have Workers
Scripts, D1, and R2 write permissions. Configure the smoke inputs as non-secret
environment variables:

```text
SMOKE_CANARY_HANDLE
SMOKE_FACET_TYPE
SMOKE_FACET_VALUE
SMOKE_CAMPAIGN   # optional
```

## Release procedure

1. Let CI pass `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm cf:build:prod`.
2. Merge to `main`. The production workflow executes `pnpm cf:deploy:prod`,
   which deploys the Worker and populates its R2 cache.
3. The workflow runs `pnpm smoke:deployment` against `https://ghfind.com`.
   Treat a failed smoke as a failed release even when the deploy command itself
   succeeded.
4. For an operator-driven verification, use the same smoke inputs described in
   [the deployment smoke guide](../releases/deployment-smoke.md).

For a development release, run `pnpm cf:deploy:dev` and smoke
`https://dev.ghfind.com`. Development must use isolated secrets and bindings;
never point it at production data merely to make a smoke pass.

## Rollback

Cloudflare retains Worker versions. List deployments, choose a known healthy
version, roll back to it, and re-run the production smoke:

```sh
pnpm exec wrangler deployments list --env production
pnpm exec wrangler rollback <healthy-version-id> --env production --yes \
  --message "rollback: <incident-or-commit>"
```

Do not modify D1 schema, D1 data, R2 buckets, or secrets as part of a code
rollback. A Worker rollback changes only the running version; database and
cache changes require their own reviewed recovery procedure.
