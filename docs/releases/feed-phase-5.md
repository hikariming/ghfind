# Feed stage 5 integration status and entry gates

Baseline: `1bc35c368a5b73a353d3b07234be653ce7cc3ac4`, updated 2026-09-09.
Stage 5 is **in progress; production Go cutover is not accepted**. The initial
application releases retain the existing Feed D1 and legacy runtime. Storage
selection in configuration is not an authorized database migration operation.

## Integrated deliveries

| Delivery | Exact source and validation | Boundary |
| --- | --- | --- |
| Stage 4 source/recovery | PR #249 tested head `4fee486dc15aca81766c012f3b63d994a81a935b`, merge `a3c3f841c15a247d5a2b187aa0f6ac5fa5e1616e` | Source finalization/outbox seam, privacy-compatible snapshot fixtures and recovery tests; source flags remain off |
| Linux capacity workflow | PR #251 tested head `85e6b47a6777b71ce603ef9565da7e9ec2424b72`, merge `1bc35c368a5b73a353d3b07234be653ce7cc3ac4` | Exact-main/CI preflight, isolated synthetic fixture, raw evidence gate, failure artifacts and cleanup |
| Ordinary Docker writer 2 | [Same-image evidence](../evidence/feed-portability-a3c3f84/README.md) at exact `a3c3f84` | API/executor startup, dependency readiness, authentication rejection and idle lifecycle; source fixture is health-only |
| Current application release | [Cloudflare readback](../evidence/feed-production-1bc35c3/README.md) | `ghfind` version `af79df38-bf39-4d4f-b561-41128564b68b`, 100%, legacy/off defaults; unchanged core/Feed D1 identities |

The stage-5 capacity implementation was split into observed S3 failure evidence,
strict raw-report validation, Linux runner orchestration and corrected resource
clock/placeholder interpretation. Main CI includes meaningful verifier regression
tests; the 600-second capacity workflow is a separate bounded manual gate.
Successful unit tests or an application deployment do not imply that gate passed.

## Capacity result and retained failure

[Linux run 34257139145](https://github.com/hikariming/ghfind/actions/runs/34257139145)
executed the exact baseline above on an isolated Ubuntu runner with 50,000
projects, 5,000 users and 1,000,000 events. The finite run offered 6,000 requests
at 10 RPS for at least 600 seconds. It failed: 4,365 HTTP 200 responses and 1,635
concurrency rejections produce a 27.25% offered-request failure rate; admitted
nearest-rank p95 is 4,001.371 ms. All successful responses had 20 items. Resource
coverage was complete and had no malformed samples. These are actual threshold
failures, not missing evidence or a passing monthly-availability measurement.

The separate bounded deletion assertions passed: cancellation rolled back the
observed active cascade, the next attempt returned 202, 250,000 old events were
removed, a real controlled S3 503 left a durable archive failure, and a reopened
adapter completed cleanup before profile generation 2 was created. This is an
isolated PostgreSQL/MinIO fixture, not remote R2, real OAuth or production recovery.
The job removed its own fixture after preserving the original artifacts. Do not
change the SLO, discard rejected requests or overwrite earlier failed reports.

## Open acceptance gates

| Gate | Current evidence and next required result |
| --- | --- |
| CF runtime and cost | Isolated resource identities and paid-feature/quota readbacks exist. Dedicated Actions credential creation and protected environment settings remain unresolved. Deploy the paired image/adapter through Actions, then measure cold/warm latency, failures and cost. |
| Performance | Linux finite-run thresholds fail. Diagnose the actual query path, retain the failing baseline, validate any repair, then run a new bounded test on its exact successful-CI main SHA. No production load test. |
| Full Feed journal | Core assessment outbox and job outbox cover only subsets. Complete same-transaction capture of all Feed fact changes is absent; core-source sequence is not a complete migration watermark. |
| Cross-profile migration | Snapshot schema validation and per-command epoch guards exist. D1↔PostgreSQL mapping, complete replay, persistent migration control, authoritative route CAS and reverse replay are not implemented. |
| Real source/queue/OAuth E2E | Local libsql/workerd/pgvector fixtures pass; authenticated GitHub OAuth, paid assessment, remote Queue failure/restart/DLQ/operator replay and delivered alerts remain unverified. |
| Object recovery and data targets | Local snapshot/deletion tests and MinIO outage recovery do not prove real R2 object transfer, full journals, an isolated restore's RPO ≤15 min / RTO ≤60 min, or a database round trip. |
| Production rollout | No Go internal-account/1%/10%/100% canary or rollback has run. Wait for stages 1, 3 and 4 operational acceptance and keep Feed D1 for the first runtime cutover. |

Historical Turso credentials were found, but two minimal authorized reads returned
HTTP 502; the [audit](../audits/2026-09-09-turso-history-readonly.md) cannot establish
historical completeness. Core D1 remains the verified current source. The old
Railway backup failure and unattributed historical proposal quarantine remain
explicit unresolved items.

## Handoff and sequencing

Public/HTTP/read contract is 1; storage writer is 2. Feed D1 migrations are through
0011 (runtime control schema value 7), PostgreSQL through 0022, core source through
0005/0006. The new migrations are outside the production application's approved
migration allowlist. A pre-privacy writer is not a compatible rollback target.
The ordinary local image ID in the linked report has not been pushed; it is not
a Cloudflare deployment manifest.

Query diagnosis, migration protocol preparation and evidence review can proceed
in separate worktrees. Shared migration numbering and source transaction changes
must remain serial. Complete journal capture precedes cross-profile replay;
both precede fencing and atomic promotion. Schema application, routing promotion,
production canary and rollback belong to one release owner through Actions.
After a promoted target accepts writes, rollback to another database requires
reverse replay and a new verified fence; changing one environment variable is
insufficient. Application rollback stays on the same fact source.

Stage 6 may prepare independent semantic components but must not activate them
before base Feed acceptance. Final stage-7 handoff still requires an actual
portable core E2E, compatible application rollback, database round trip, object
restore, measured cost and a documented legacy-service disposition. No key values
belong in a handoff or public Actions artifact.
