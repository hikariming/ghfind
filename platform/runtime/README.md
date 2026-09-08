# Independent Feed runtime on Cloudflare

This Worker runs the same `Dockerfile.feed` image in two API slots (`api-0`,
`api-1`) and one executor slot (`executor-0`). It supplies platform routing,
request authentication, private binding access, bounded source-outbox relay and
at-least-once queue delivery. Feed business logic lives in Go. No request-derived
instance ID can expand the population; configuration caps API at two `basic`
instances and executor at one. API sleeps after two minutes idle; executor after
ten seconds. Container files are temporary and contain no durable task state.

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
| `feed-archive.internal` | Executor only; executor bearer, exact `health`/`put`/`get` capabilities, 6 MiB wire and 4 MiB decoded object limits. |
| `feed-cleanup.internal` | Executor only; executor bearer and exact `claim`/`step`/`fail`/`release` cleanup commands. Operator status/replay capabilities are unavailable to Go. |

Outbound Internet access is disabled. The adapter owns the versioned D1/R2
capabilities; it offers no arbitrary SQL or runtime DDL. `FEED_SOURCE_SECRET`,
`FEED_BRIDGE_SECRET`, `FEED_EXECUTOR_SECRET`, `FEED_GATEWAY_SECRET`,
`FEED_SIGNING_SECRET`, `FEED_RUNTIME_ADMIN_SECRET` and `FEED_DELIVERY_SECRET` must be independent values
of at least 32 bytes. Never place values in a manifest, evidence file or logs.
`FEED_OPERATOR_SECRET` is an additional independent adapter-only credential for
protected manual status/replay operations. It is never uploaded to the runtime
Worker or injected into a Go Container. Delivery credentials belong only to runtime and adapter; neither the delivery nor runtime operations credential enters Go. Semantic cleanup state remains explicitly
`disabled` until a later semantic rollout supplies and validates that capability.
The gateway signature contains GitHub identity, service audience, short validity,
HTTP method, exact path/query and SHA-256 of the body.

The minute cron claims at most 100 indexed source-outbox records with a 60-second
lease. It validates reference envelopes and excludes lease token and attempts
from queue messages. Each message is `{contractVersion:1,deliveryId,event}`; initial delivery IDs are `source:<sourceVersion>`, and replay IDs are command UUIDs. Go receives only the validated inner event. Successful queue publication is followed by conditional
source confirmation. Publication failure or uncertainty stays retryable; failed
confirmation leaves the lease to expire. Confirmation uses bounded parallelism
and deadlines below the source lease duration. This incremental relay never scans
the project catalog or infers deletion from missing scan results.

The same cron independently checks the adapter's indexed
`POST /internal/feed/cleanup/v1/pending` capability. When no deletion is due it
does not start a Container. When work is due it calls Go
`POST /internal/feed/jobs/cleanup` exactly once with `{}` and the executor
credential. Go owns the 60-second task context, at most eight bounded steps,
checkpointing and lease release; transport allows 75 seconds. `queued` remains
unfinished work. A third branch checks durable replay delivery work, claims at most 20 leases with a fresh UUID and a 45-second total publication budget inside each 60-second lease, and confirms only successful queue publication. All three branches are awaited even when one fails, and failures are
logged separately without deletion identifiers. Empty source claims likewise
produce no queue delivery and do not wake Go. These checks prevent empty cron
runs from making staging Containers permanently active.

Main queue configuration uses batch size one, concurrency one, five retries and an
explicit DLQ. Its consumer separately persists the terminal generation in D1 before acknowledgement; an old generation can be recorded without marking a new replay failed. DLQ persistence errors retry five times then move to a separate terminal-parking queue, with no automatic consumer and verified paid 14-day retention. Parking has finite retention; alert delivery and an assigned responder must be exercised before production. Do not treat queue retention as a substitute for reconstructible source outbox and delivery state. Executor calls have a 75-second transport deadline for the Go task's
60-second budget. Only a matching event ID with persisted `completed` or
`duplicate` outcome is acknowledged; `accepted`, bad JSON, errors and timeouts
retry. Go storage must persist task deduplication, leases and projection before
returning success. Invalid messages exhaust finite retries into DLQ. Source retry
exhaustion, real DLQ/parking alerts and durable task recovery require the next-stage
operational checks; an error log alone is not configured alert delivery.

## Reproducible local checks

From repository root:

```sh
npm ci --prefix platform/runtime
npm run types --prefix platform/runtime
npm run typecheck --prefix platform/runtime
npm test --prefix platform/runtime
npm run build --prefix platform/runtime
node --test scripts/feed-platform-manifest.test.mjs scripts/feed-platform-provision.test.mjs scripts/feed-platform-verify-resources.test.mjs scripts/feed-operator.test.mjs
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
queue, DLQ and terminal-parking queue using the exact names emitted by the dry-run plan. An environment
manifest records the resulting IDs, reviewed isolation evidence, paid billing
qualification, a monthly estimate at or below USD 80 and completed durable
executor implementation. `staging.manifest.example.json` intentionally fails
these gates. Known production/shared-development D1 IDs, equal database IDs,
unknown fields, mutable image tags and credential-bearing evidence URLs reject.

Use the protected GitHub environment **Feed staging**, dedicated
`CF_FEED_STAGING_API_TOKEN`, seven named runtime secrets plus the adapter-only `FEED_OPERATOR_SECRET`, and environment variables
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

## Provisioning receipt and bounded recovery

`scripts/feed-platform-provision.mjs` defaults to an offline five-resource plan
with its original SHA-256 plan hash. Terminal parking is a supplemental separately reviewed creation/readback receipt; it does not change that five-resource plan or invalidate an existing receipt. Deployment requires `terminalParkingQueue` in the manifest and independently checks 14-day retention and absence of a consumer. `--inspect` reads only those fixed staging names. An
operator can execute the reviewed plan with:

```sh
node scripts/feed-platform-provision.mjs --plan
node scripts/feed-platform-provision.mjs --inspect
node scripts/feed-platform-provision.mjs --apply --reviewed-plan REVIEWED_PLAN_HASH --receipt platform/runtime/provision.evidence.json
```

Provide `CLOUDFLARE_API_TOKEN` through the runner environment, never an argument.
For the existing Wrangler OAuth context, the exported `provision()` accepts an
authenticated `request({method,path,body})` transport returning only
`{status,success,result,result_info}`, plus a persistent `onReceipt` callback.
This avoids storing credentials in the provision journal. The account is fixed;
only five exact creation bodies and their metadata reads are accepted. Official
schemas: [D1 creation](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/),
[R2 creation](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/),
[queue creation](https://developers.cloudflare.com/api/resources/queues/methods/create/).

All names are inspected before the first write. Unknown existing resources,
ambiguous listings, production IDs, absent recorded resources or permission
failures stop execution. The journal is persisted **before** each create, then
the resource is read back by its exact name and ID. A completed receipt can be
rerun without duplicate creates. An uncertain response leaves a pending record;
there is no automatic retry, adoption or deletion. The release owner must inspect
and reconcile that one pending resource before resuming. This conservatively
also stops on explicit creation errors. Partial resources remain isolated and
are listed in the receipt. Copy their two D1 IDs to the deployment manifest and
separately supply actual isolation/qualification evidence; creation does not
mark billing, executor implementation, runtime compatibility or E2E as passed.

## Local startup compatibility review

The runtime must export the SDK's `ContainerProxy`; Containers SDK 0.3.7 otherwise
throws before installing outbound host handlers. The Worker now exports it and
its dry-run bundle is checked. The Go executor must consume
`FEED_CLEANUP_ENDPOINT=http://feed-cleanup.internal`, and its HTTP transport must
explicitly accept that private host. Using the ordinary bridge endpoint for
cleanup would fail the host/path/credential boundary. Coordinate those Go changes
with the runtime change before deployment.

The adapter must declare bridge, source, executor, operator and delivery secrets; staging
secrets are divided between Worker roles. Its cleanup `pending` capability and
cleanup schema must be deployed before the runtime cron. The isolated core
migrations are needed for source readiness, and the Feed migrations for job,
request/session and cleanup readiness. Image push and version inspection
explicitly select the Feed runtime config, so they cannot inherit the existing
production Worker's root config. Reviewed readiness fields, auth DTO names and
writer epoch match the current Go runtime; deployment still must prove them.

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
[Container instance prices and separately billed services](https://developers.cloudflare.com/containers/platform/pricing/),
[DLQ retry exhaustion](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/),
[finite queue retention and limits](https://developers.cloudflare.com/queues/platform/limits/).

Handoff records must include the reviewed source SHA, runtime/adapter/image and
contract versions, schema versions, resource manifest, Actions run and evidence
artifact IDs, actual probes and their limitations, compatible previous application
version, unresolved gates and next-stage entry criteria. Keep secret values out
of all handoff material. The stage 0
[audit](../../docs/audits/2026-09-08-feed-platform.md) and
[operator prerequisites](../../docs/operations/feed-platform-prerequisites.md)
remain the factual source for unresolved account and release protection gates.

### Credentials and container roles

Only API containers receive gateway and Feed token signing keys. Only the executor
receives source and executor keys and source/cleanup/archive endpoints. Both use
the private storage bridge with role-specific outbound operation allowlists: API
serving commands and executor job/projection commands cannot cross those routes.
The operator, delivery and runtime administration keys never enter either Go
container. CF executor readiness probes the archive binding as well as Feed D1
and the assessment source.
