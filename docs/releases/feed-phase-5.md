# Feed stage 5 integration status and entry gates

Runtime validation baseline: `0ca53012559a512d61a55a5eca373dca2f8f139c`, updated 2026-09-09.
Integrated main baseline: `2a8373be4ce1d5141c2269bd9f4cfc29b0c424c6` (PR #260).
Stage 5 is **in progress; production Go cutover is not accepted**. The initial
application releases retain the existing Feed D1 and legacy runtime. Storage
selection in configuration is not an authorized database migration operation.

## Integrated deliveries

| Delivery | Exact source and validation | Boundary |
| --- | --- | --- |
| Stage 4 source/recovery | PR #249 tested head `4fee486dc15aca81766c012f3b63d994a81a935b`, merge `a3c3f841c15a247d5a2b187aa0f6ac5fa5e1616e` | Source finalization/outbox seam, privacy-compatible snapshot fixtures and recovery tests; source flags remain off |
| Linux capacity workflow | PR #251 tested head `85e6b47a6777b71ce603ef9565da7e9ec2424b72`, merge `1bc35c368a5b73a353d3b07234be653ce7cc3ac4` | Exact-main/CI preflight, isolated synthetic fixture, raw evidence gate, failure artifacts and cleanup |
| Ordinary Docker writer 2 | [Same-image evidence](../evidence/feed-portability-a3c3f84/README.md) at exact `a3c3f84` | API/executor startup, dependency readiness, authentication rejection and idle lifecycle; source fixture is health-only |
| Ordinary Docker business HTTP | PR #260 tested head `5c2a094aae65e61047dd530e700d524995b88c8e`, merge `2a8373be4ce1d5141c2269bd9f4cfc29b0c424c6`; [actual run and retained setup failure](../evidence/feed-docker-http/README.md) at exact `39def663ab662e66e0b3473dfc06285e761c2a26` | Standard API image with PostgreSQL passed 21 HTTP calls; synthetic identities and direct projections; deletion cleanup remains queued, no worker/S3/source/OAuth E2E |
| Transfer v1 preparation | PR #253, merge `2444482e49b4e88e375d9ecdc82cb80d97f1a20d`; [contract](../contracts/feed-transfer-v1.md) | Strict source/target identity, transaction hashes and deletion overlays; no capture, mapping or database promotion; whole-transaction limits cannot yet represent large deletion cascades |
| Segmented transfer preparation | PR #258 head `e5e6edfc900289d560d1f6d85f948f26628953a8`, merge `a6e2199a94d64caa7b8429b61b6a1c2ec5e893d0`; [v2 contract](../contracts/feed-transfer-segments-v2.md) | 250,000 synthetic changes in bounded segments, complete deletion-semantic passes and exact lost-ack confirmation; v1 unchanged, no actual capture/staging/apply |
| Actual-query diagnosis | PR #254, merge `45d6427a22943d23ce3acb413cff20dd9f4ef61b`; [Linux evidence](../evidence/feed-linux-query-diagnosis-45d6427/README.md) | 100 sequential synthetic requests and 16 exact-template plans; diagnosis is not capacity acceptance |
| Tag recall repair | PR #255 head `75a031849cedeae9a67170077ada7692487a7cf9`, merge `0ca53012559a512d61a55a5eca373dca2f8f139c`; [equivalence evidence](../evidence/feed-tag-analysis-recall-4dbb89f/README.md) | Replaces full-catalog current-analysis join with indexed existence checks before the unchanged per-preference bound; real PostgreSQL regression CI and the new Linux finite-run gate passed |
| Observed application release | [Cloudflare readback](../evidence/feed-production-0ca5301/README.md) at `2026-09-08T18:41:55Z` | `ghfind` version `3fac2561-fc17-4592-bc47-5fffc8460acb`, 100%, legacy/off defaults; unchanged core/Feed D1 identities |
| Runtime identity check | PR #257, merge `cd0466116aa245982f2243c61547469caa50085b` | Health/readiness report distinct numeric storage writer 2 and string HTTP contract 1; lifecycle probes require both; no schema or route change |

The stage-5 capacity implementation was split into observed S3 failure evidence,
strict raw-report validation, Linux runner orchestration and corrected resource
clock/placeholder interpretation. Main CI includes meaningful verifier regression
tests; the 600-second capacity workflow is a separate bounded manual gate.
Successful unit tests or an application deployment do not imply that gate passed.

## Capacity result and retained failure

[Linux run 34257139145](https://github.com/hikariming/ghfind/actions/runs/34257139145)
executed `1bc35c368a5b73a353d3b07234be653ce7cc3ac4` on an isolated Ubuntu runner with 50,000
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

The later Linux diagnosis at `45d6427` identified `candidates.tag` as the dominant
measured SQL path: 13,440.030 ms across 100 requests, 79.20% of summed request SQL
timing. The independent local comparison verified identical ordered candidates
and affinities before the narrow PR #255 query change. These observations justify
a new capacity run; they do not prove its outcome. PR CI records both its head and
actual test-merge checkout. Exact-main CI
[34263794374](https://github.com/hikariming/ghfind/actions/runs/34263794374)
passed before dispatching a new fixed 600-second gate at `0ca5301`:
[34264216366](https://github.com/hikariming/ghfind/actions/runs/34264216366).
The [preserved result](../evidence/feed-linux-capacity-0ca5301/README.md) passed:
all 6,000 offered requests returned HTTP 200 with 20 items, with no admission
rejection or transport failure. Admitted nearest-rank p95 was **57.326 ms**,
p99 **60.488 ms**, and maximum **85.536 ms** over 600.081 seconds. All 600 internal
observation seconds were valid; external coverage was complete with no malformed
samples. The coordinator independently loaded the verifier from the exact source
SHA and recomputed the original `gate.json` without modifying it; results matched.

This run also passed observed deletion cancellation/rollback, 250,000-event
deletion, two actual controlled S3 503 requests with persisted failure state,
reopened-adapter cleanup completion and profile generation 2. The accepted DELETE
response took 1,393.394 ms; Feed GET latency must not be substituted for deletion
latency. The job removed its own synthetic resources. No repeat load was needed
after this passing result. This is one finite PostgreSQL/MinIO engineering gate,
not statistical monthly availability, a Container benchmark, remote D1/R2 recovery
or CF cost acceptance.

## Ordinary Docker business result

The corrected Docker run used the standard API entrypoint and image
`sha256:78d3ef65c62b5a2cc1131d0e64b0da365603d0bb39c93dd84437616528156e0a`,
built from exact source `39def663ab662e66e0b3473dfc06285e761c2a26`.
After validating all 34 tables' expected initial state, the bounded contract
seeded 50 synthetic projects and submission receipts, then passed 21 HTTP calls
in 0.657723959 seconds. It checked authentication rejection, stable pagination,
owner caps, event replay, user isolation and deletion fencing. A recreated user
advanced from deleted generation 4 to generation 5. Cleanup status remained
`queued`: the API did not execute the background deletion task.

The [evidence package](../evidence/feed-docker-http/README.md) preserves the initial
setup failure and successful rerun, image/build identities and original reports.
Independent byte/hash verification covered 18 retained original files and four
omitted helper binaries; the separate cleanup readback matched all nine owned
resource identities and reported them absent. The successful source predates
PR #257, so its health reports do not contain `storageWriterVersion`; the original
fields are unchanged. Neither image was pushed or deployed to Cloudflare.

PR #260's complete [CI](https://github.com/hikariming/ghfind/actions/runs/34267105628)
and its exact-main [CI](https://github.com/hikariming/ghfind/actions/runs/34267663737)
passed. Those checks include the original real dual-store contract, Docker/Worker
builds and pure harness guards; the separately recorded Docker execution is the
business-HTTP evidence. A complete portable core E2E still needs the executor,
source tasks, object cleanup/recovery and the relevant authenticated flow.

## Open acceptance gates

| Gate | Current evidence and next required result |
| --- | --- |
| CF runtime and cost | Isolated resource identities and paid-feature/quota readbacks exist. Dedicated Actions credential creation and protected environment settings remain unresolved. Deploy the paired image/adapter through Actions, then measure cold/warm latency, failures and cost. |
| Performance | The original Linux failure is retained; the new exact-main 10 RPS/600-second PostgreSQL gate passes with full raw evidence. Next measure the isolated CF runtime with D1 scanned rows, cold starts, task backlog and cost. The local result does not establish that platform's SLO. |
| Full Feed journal | Core assessment outbox and job outbox cover only subsets. Complete same-transaction capture of all Feed fact changes is absent; core-source sequence is not a complete migration watermark. |
| Cross-profile migration | Snapshot schema validation, per-command epoch guards and v1/v2 offline transfer validation exist. Complete capture/staging, D1↔PostgreSQL mapping, atomic apply, persistent migration control, authoritative route CAS and reverse replay are not implemented. The existing PG retention path permits null event request IDs that D1 schema 11 cannot directly represent; no value substitution or row loss is authorized. |
| Real source/queue/OAuth E2E | Local libsql/workerd/pgvector fixtures pass; authenticated GitHub OAuth, paid assessment, remote Queue failure/restart/DLQ/operator replay and delivered alerts remain unverified. |
| Object recovery and data targets | Local snapshot/deletion tests and MinIO outage recovery do not prove real R2 object transfer, full journals, an isolated restore's RPO ≤15 min / RTO ≤60 min, or a database round trip. |
| Production rollout | No Go internal-account/1%/10%/100% canary or rollback has run. Wait for stages 1, 3 and 4 operational acceptance and keep Feed D1 for the first runtime cutover. |

Historical Turso credentials were found, but the two initial minimal authorized
reads and a later single bounded availability recheck returned HTTP 502;
the [audit](../audits/2026-09-09-turso-history-readonly.md) cannot establish
historical completeness. Core D1 remains the verified current source. The old
Railway backup failure and unattributed historical proposal quarantine remain
explicit unresolved items.

## Handoff and sequencing

Public/HTTP/read contract is 1; storage writer is 2. Feed D1 migrations are through
0011 (runtime control schema value 7), PostgreSQL through 0022, core source through
0005/0006. The new migrations are outside the production application's approved
migration allowlist. A pre-privacy writer is not a compatible rollback target.
The ordinary local image IDs in the linked reports have not been pushed; they
are not Cloudflare deployment manifests. The two images created for the bounded
business-HTTP attempts were removed after their reports were retained.

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
