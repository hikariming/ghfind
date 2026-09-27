# Historical Go backend extraction runbook

> **Archived architecture.** This document describes the retired Vercel frontend
> plus Railway/Go backend split. The current frontend and backend run together in
> the Cloudflare Worker. The split backend was deleted; each section below keeps
> a one-line pointer. Use the [current Cloudflare
> deployment runbook](./cloudflare-deployment-runbook.md) instead.

## Ownership and topology

Removed: the Go score/scan API (`cmd/ghfind-api`) and worker (`cmd/ghfind-worker`) were deleted in the score v11 cutover; the Cloudflare Worker owns every route (see [backend route ownership](./backend-route-ownership.md)).

## Required private environment

Removed with the Go API/worker; Worker secrets are listed in the [Cloudflare deployment runbook](./cloudflare-deployment-runbook.md).

## Local E2E smoke

Removed: `docker-compose.backend.yml`, `Dockerfile.backend` and the `smoke:backend:*` scripts were deleted with the Go API/worker.

## Staging environment (verified)

Removed: `scripts/deploy-staging.sh`, `railway.json` and the Railway staging stack were deleted with the Go API/worker.

## Production rollout and rollback

Removed: use the [Cloudflare deployment runbook](./cloudflare-deployment-runbook.md) for rollout and rollback.

## Go code that remains

`internal/backend` now contains only the Feed backend (served by `cmd/feed-api` and `cmd/feed-worker`, see the [Feed operator runbook](./feed-operator-runbook.md)). Build and test it with `make feed-build feed-test`.
