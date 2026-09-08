# Independent Feed runtime on Cloudflare

This Worker runs the same `Dockerfile.feed` image in two API slots (`api-0`,
`api-1`) and one executor slot (`executor-0`). It supplies platform routing,
request authentication, private binding access, bounded source-outbox relay and
at-least-once queue delivery. Feed business logic lives in Go. No request-derived
instance ID can expand the population; configuration caps API at two `basic`
instances and executor at one. API sleeps after two minutes idle; executor after
one minute. Container files are temporary and contain no durable task state.

The checked-in config is deliberately unconfigured. Local build is a Wrangler
**dry run**; it is not a deployment or proof of Container compatibility. The
integration owner must exclude this independently checked package and its
generated Worker globals from the Next TypeScript and ESLint file sets.

## Contracts and boundaries

| Surface | Authority and behavior |
| --- | --- |
| `GET /healthz` | Runtime liveness and build/contract version; no dependency readiness claim. |
| `GET /readyz` | Dedicated operations bearer; probes all three slots and requires current Go SHA, contract `1`, `cf_d1_r2`, writer epoch and enabled durable executor. |
| `/api/feed/*` | Requires request-bound `X-Feed-Gateway` HMAC before waking a Container; strips client identity, cookies and unrelated headers; Go independently verifies the signature. Maximum request body 128 KiB. Responses retain `no-store`. |
| `/internal/runtime/{slot}/ready` | Operations bearer and fixed slot only; returns actual Go dependency readiness. |
| `POST /internal/runtime/{slot}/stop` | Operations bearer, empty body and staging environment only; awaits `SIGTERM` stop. |
| `feed-bindings.internal` | Container outbound allowlist to the `FEED_ADAPTER` service binding; private POST capability path, bridge bearer and contract header required. |
| `feed-source.internal` | Executor only; source bearer and exact `health`/`assessment` paths. Source outbox claim/finish are unavailable to Go. |

Outbound Internet access is disabled. The adapter owns the versioned D1/R2
capabilities; it offers no arbitrary SQL or runtime DDL. `FEED_SOURCE_SECRET`,
`FEED_BRIDGE_SECRET`, `FEED_EXECUTOR_SECRET`, `FEED_GATEWAY_SECRET`,
`FEED_SIGNING_SECRET` and `FEED_RUNTIME_ADMIN_SECRET` must be independent values
of at least 32 bytes. Never place values in a manifest, evidence file or logs.
The gateway signature contains GitHub identity, service audience, short validity,
HTTP method, exact path/query and SHA-256 of the body.

The minute cron claims at most 100 indexed source-outbox records with a 60-second
lease. It validates reference envelopes and excludes lease token and attempts
from queue messages. Successful queue publication is followed by conditional
source confirmation. Publication failure or uncertainty stays retryable; failed
confirmation leaves the lease to expire. Confirmation uses bounded parallelism
and deadlines below the source lease duration. This incremental relay never scans
the project catalog or infers deletion from missing scan results.

Queue configuration uses batch size one, concurrency one, five retries and an
explicit DLQ. Executor calls have a 75-second transport deadline for the Go task's
60-second budget. Only a matching event ID with persisted `completed` or
`duplicate` outcome is acknowledged; `accepted`, bad JSON, errors and timeouts
retry. Go storage must persist task deduplication, leases and projection before
returning success. Invalid messages exhaust finite retries into DLQ. Source retry
exhaustion, DLQ alerts/replay and durable task recovery require the next-stage
operational checks; an error log alone is not configured alert delivery.

## Reproducible local checks

From repository root:

```sh
npm ci --prefix platform/runtime
npm run types --prefix platform/runtime
npm run typecheck --prefix platform/runtime
npm test --prefix platform/runtime
npm run build --prefix platform/runtime
node --test scripts/feed-platform-manifest.test.mjs
node scripts/feed-platform-manifest.mjs
node scripts/feed-platform-cost.mjs
```

The last two scripts print a dry-run resource plan and an explicitly unmeasured
cost scenario. None creates resources. Contract tests exercise authentication,
header isolation, request bounds, readiness mismatch, fixed instance selection,
queue completion and source relay failure/lease behavior. They mock dispatch;
they do not claim real D1, Container lifecycle or OAuth E2E evidence.

## Isolated staging release

The integration owner provisions separate core D1, Feed D1, R2 archive, main
queue and DLQ using the exact names emitted by the dry-run plan. An environment
manifest records the resulting IDs, reviewed isolation evidence, paid billing
qualification, a monthly estimate at or below USD 80 and completed durable
executor implementation. `staging.manifest.example.json` intentionally fails
these gates. Known production/shared-development D1 IDs, equal database IDs,
unknown fields, mutable image tags and credential-bearing evidence URLs reject.

Use the protected GitHub environment **Feed staging**, dedicated
`CF_FEED_STAGING_API_TOKEN`, six named runtime secrets, and environment variables
`FEED_STAGING_MANIFEST` (nonsecret JSON) and `FEED_STAGING_RUNTIME_URL` (the exact
staging `workers.dev` origin). The token must support the isolated Workers,
Containers/registry, D1 migrations, R2 metadata and queue operations needed by the
workflow. Confirm its scope with the account administrator; do not substitute a
production token when it is missing. Account subscriptions returned 403 in the
audit. The integration owner's subsequent read-only evidence reports Billing and
Containers write/admin roles plus successful `GET /accounts/{account}/containers/me`
quota access (4 vCPU, 12 GiB memory and 20 GB disk per deployment; 1,500 vCPU,
6 TiB memory and 30 TB disk account totals). This supports initial staging
technical qualification. The older `cloudchamber/me` 401 does not invalidate that
successful current endpoint. Subscription invoice details remain unreadable;
these roles and quotas are not measured costs or a billing cap. Record the
reviewed qualification evidence in the manifest without repeatedly asking for
the same inaccessible subscription endpoint.

`.github/workflows/feed-staging.yml` accepts an exact full SHA and requires a
successful repository `ci.yml` run for that SHA. It validates sources before any
mutation, reads back every resource's name/ID, builds the portable linux/amd64
image, pushes it using the pinned Wrangler CLI, and obtains the registry digest.
Only then does it render ignored configs, apply the two isolated schemas, deploy
the private adapter and deploy the runtime referencing that digest. Secret files
are ephemeral runner files and excluded from artifacts.

The workflow waits for all Go binaries to report the expected SHA and dependency
readiness, runs bounded restart/concurrency probes, then verifies the actual
active Worker version, Container application image digest and each running
instance's application version through read-only Wrangler queries. A configured
digest in a response alone is not evidence of a running image. Prebuilding does
not make Worker/Container rollout transactional; keep the contract compatibility
window and hold subsequent promotion until all versions agree. A failed staging
job leaves evidence and does not silently promote or roll back a database.

## Evidence still required

This change has not provisioned resources or run a remote deployment. The probe
harness performs at most 18 provisioning readiness attempts, three explicit
SIGTERM stops/restarts and three waves of six concurrent dependency reads.
Provisioning waits are not cold-start latency samples. It records measured
request durations but does not certify p95 from these few lifecycle samples.
Temporary-disk loss, instance failure during durable execution, actual Docker/CF
image equivalence, real OAuth and assessment, recovery, capacity (10 RPS for ten
minutes), p95 <=800 ms warm / <=5 s cold, costs and source-to-projection latency
remain explicit stage acceptance items. Production cutover is a later protected
Actions workflow; this workflow cannot change production resources or routing.

The rate-card scenario is USD 79.70/month: all three production `basic` slots
running 730 hours at full allocated CPU, the three staging slots running 40 hours
each, USD 5 base Workers plan and an **assumed** USD 10 combined allowance for
other services. Shared-account included usage is not deducted. Forty staging
hours and USD 10 are planning assumptions, not enforced limits or measured
invoices; replace them with metered D1/R2/Queues/Workers/DO/log/egress/AI usage.
The USD 100 total budget and USD 80 planning gate remain; instance caps alone
cannot cap the bill. Semantic calls are not activated here.

Official references checked 2026-09-08:
[bindings through outbound handlers](https://developers.cloudflare.com/containers/configuration/workers-connections/),
[nontransactional deployment and running-version checks](https://developers.cloudflare.com/containers/guides/deploy/),
[Container instance prices and separately billed services](https://developers.cloudflare.com/containers/platform/pricing/).

Handoff records must include the reviewed source SHA, runtime/adapter/image and
contract versions, schema versions, resource manifest, Actions run and evidence
artifact IDs, actual probes and their limitations, compatible previous application
version, unresolved gates and next-stage entry criteria. Keep secret values out
of all handoff material. The stage 0
[audit](../../docs/audits/2026-09-08-feed-platform.md) and
[operator prerequisites](../../docs/operations/feed-platform-prerequisites.md)
remain the factual source for unresolved account and release protection gates.
