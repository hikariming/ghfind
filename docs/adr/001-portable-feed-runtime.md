# ADR 001: portable Feed runtime and data ownership

Accepted for implementation: 2026-09-08. Baseline: `41ce4cd829f431fa2e20133e0c2509bbe1d5fad3`.
This is an implementation decision, **not evidence that any deployment gate has passed**.

## Decision

Run an independent Go Feed API and a separate bounded Go task executor. Prefer
Cloudflare Containers, with Workers providing ingress, D1/R2 capabilities and
queue delivery. Next retains OAuth, pages and a same-origin gateway. Neither Go
entry point starts legacy scanning, evaluation or RabbitMQ consumers.

The production storage profile is initially `cf_d1_r2`, using the existing
dedicated Feed D1. Deliver a second `postgres` profile with pgvector and an S3
compatible archive. Business code must run from the same Go images in ordinary
Docker without a Cloudflare or Next runtime. Vector indexes are rebuildable
derived data; the relational store decides eligibility and deletion state.

| Data / route | Owner | Change boundary |
| --- | --- | --- |
| OAuth, public pages, rankings, scans, assessments | Existing application | Preserve behavior and current production facts |
| Assessment finalization and submission evidence | Core database | Add source outbox in the same transaction; no downstream synchronous dependency |
| `/api/feed/*` | Next gateway → independent Go API when enabled | Preserve paths, OAuth requirement, error shape and `no-store` |
| Catalog projection, taxonomy, preferences, events, sessions, tasks | One Feed primary store | D1 initially; PostgreSQL is a separately rehearsed promotion |
| Archives, snapshots, restore manifests | R2 / S3 archive adapter | Versioned, checksummed, retention and deletion aware |
| Semantics | Embedding provider + Vectorize / pgvector adapter | Independent switch; off until quality, recovery and cost gates pass |

Production core D1 is the observed assessment source. Historical Turso comparison
is an unresolved audit item, not authority to overwrite either store. Preserve
the already-applied résumé-library migration from the dev branch. Historical
completed evaluations alone do not prove active submission: default to excluding
such projects from the new Feed until a verifiable receipt is linked. Keep their
public project pages. Do not approve the existing tag proposal backlog by seed.

## Boundaries

Storage ports represent complete business commands. A preference update includes
its event/version/outbox; a served page includes its request and all items. No
arbitrary SQL RPC, runtime DDL, or D1 management REST in the request path. A
cross-network sequence is never described as a transaction.

`FEED_BACKEND` selects legacy or Go runtime, with legacy as the default.
`FEED_STORE_PROFILE` selects an adapter at startup. Neither is a database migration
mechanism. Every write must honor a persistent writer epoch and user deletion
generation. Promotion uses a versioned control record, snapshot, replay,
verification and a write fence. Only one store may accept authoritative writes.

The gateway signs a short-lived, request-bound identity using a dedicated secret.
Go never trusts a bare GitHub ID or a forwarded OAuth cookie. Internal capability,
gateway and impression/cursor signing secrets have distinct purposes.

New tasks have durable idempotency keys, state, deadlines, leases, finite retries,
DLQ and replay. Persist effects before acknowledgement. Source outbox success is
independent of Feed or queue availability. Explicit full repair is limited to four
pages of at most 100 entries; partial scans cannot prove deletion.

## Deployment and cost gates

Create an isolated staging core D1, Feed D1, R2, queues and credentials. Existing
dev shares the production core D1 and is not a write-test target. Production
deployment, migration and rollback run only in GitHub Actions. Deploy immutable
images before Workers, then verify actual running image and readiness before
routing traffic; Worker and Container rollout are not atomic.

Measure warm p95 ≤800 ms, cold p95 ≤5 s, projection p95 ≤60 s, availability target
99.9%, application rollback ≤5 min and restore RPO ≤15 min / RTO ≤60 min. Use
50,000 projects, 5,000 users and 1,000,000 events in isolation, with bounded
10 RPS for 10 minutes. Record cold and uncached paths, errors, database work,
queue lag and cost. These numbers are acceptance targets until measured.

New production plus staging budget: $100/month, forecast at most $80 plus $20
reserve. Initially cap API at two basic Containers and executor at one; staging
runs on demand. Include Workers, DO, logging, storage, network and embeddings.
Budget alerts are not a guaranteed spending cap. Preserve accepted jobs and
deletion recovery before optional semantic backfills.

Railway is a fallback only after measured CF failure despite reasonable
optimization, or a documented platform limitation. Missing permissions and first
deployment failures do not establish infeasibility. A fallback uses new isolated
resources and the same images; legacy Railway services remain until separately
authorized disposition.

## Delivery dependencies

Stage 0 freezes facts and contracts. Stages 1 (runtime/platform) and 2 (storage)
may then proceed in parallel. Stages 3 (API) and 4 (async/recovery) depend on the
atomic storage contract. Stage 5 waits for all of 1, 3 and 4 before integration,
migration rehearsal and production rollout. Semantics is stage 6; operational
handoff and portability proof are stage 7.

Use independent branches/worktrees, at most the primary agent plus three
subagents. The primary agent serializes shared DTOs, migration numbering, source
transactions, resource mutations and releases. Each stage has its own PR and
purposeful commits. Handoff records base/commit SHAs, contract/schema versions,
tests, resource IDs, rollback point and unmet entry gates; never secret values.

## References

- [Workers and Container connections](https://developers.cloudflare.com/containers/configuration/workers-connections/)
- [Container architecture](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Container deployment ordering](https://developers.cloudflare.com/containers/guides/deploy/)
- [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
