# Local PostgreSQL capacity acceptance: ebda1f9

**Result: failed reliability acceptance.** This single bounded run completed all
6,000 offered arrivals, with 5,912 successful HTTP responses, 69 concurrency-cap
rejections and 19 transport failures. The offered-request error rate is
**1.4667% (88/6,000)**. Meeting the 800ms p95 target does not make this run pass.
No second load run was started after the conversation interruption.

## Frozen source and scope

- Business/runtime baseline: `ebda1f9d43c4092ec038f2513ef0be32f6d0a80f`.
- Instrumented binary source: `f23ce0ffa1bd887f60a95c94fcae527137fe5d6a`;
  only bounded request/resource observations and their runbook differ from the
  business baseline. Working tree was clean when built and run.
- Binary SHA-256: `5bc45401ca7c4e8e769377fcbe88b6caf14a7b79730424915e437c3d9279c060`.
- Post-processing tool: `d7902f9` (`scripts/summarize-feed-capacity.py`). It reads
  existing artifacts only. It was added after the load and did not run requests.
- PostgreSQL migrations 1–22, reader contract 1, storage writer contract 2;
  governance, current-analysis session identity and proposal privacy fences are
  included. The pre-privacy writer-1 executable is not a compatible rollback.
- Real local pgvector/PostgreSQL and MinIO; the same standalone Go API handler
  and signed gateway request contract run through an actual `httptest` HTTP
  server. Signatures use explicit synthetic fixture credentials. This is **not**
  GitHub OAuth, Cloudflare staging, deployed Container, cold-start, cost, backup
  restore or production-availability evidence.

The fixture contains 50,000 synthetic projects, 5,000 synthetic users, 1,000,000
whitelisted events, 50,000 matching submission-evidence rows and 100,000 project
tags. All projects and receipts are generated; no historical unknown project was
promoted. One synthetic user owns 250,000 events. Initial database size was
754,464,435 bytes; seed execution took 45.710s. `fixture.json`, `schema.json` and
`query-plans.json` preserve cardinalities, compatibility and actual pre-load
EXPLAIN ANALYZE output. The five diagnostic plans returned latest 40 rows
(0.173ms), quality 20 (0.314ms), discovery 20 (0.232ms), tag 80 (2.148ms), and an
impression-hit existence result (0.039ms). These individual pre-load plans do not
explain later stalls or substitute for whole-request latency.

Host: macOS arm64, Go 1.26.1, 10 logical CPUs and 16GiB RAM. PostgreSQL was limited
to 2 CPUs/2GiB, MinIO to 0.5 CPUs/512MiB. The exact image digests, binary and source
file hashes are in `environment.json`. The test used only loopback 55441/59002
and an exclusive `feed_capacity_test` database. Other local heavy integration
runs were coordinated to finish before this run; this is not proof that the
host or Docker VM had no unrelated activity.

## Exact request window and result

| Measurement | Observed value |
| --- | --- |
| Load start UTC | 2026-09-08T05:45:28.629964Z |
| Last arrival dispatched UTC | 2026-09-08T05:55:29.131258Z |
| Last response finished UTC | 2026-09-08T05:55:29.223880Z |
| Actual request window | 600.593916 seconds |
| Total report phase, including setup/observation shutdown | 608.405472 seconds |
| Configured rate/duration | 10 RPS / 600 seconds; 100ms ticker, 6,000 arrivals |
| Admission/deadline | At most 20 in flight; five-second HTTP timeout |
| Offered / admitted / successful | 6,000 / 5,931 / 5,912 |
| Errors over all offered arrivals | 69 cap rejections + 19 transport failures = 1.4667% |
| Admitted p50 / p95 / p99 / maximum | 97.346 / 136.707 / 2,344.481 / 5,113.205ms |
| HTTP-response p50 / p95 / p99 / maximum | 97.327 / 129.821 / 2,054.024 / 4,150.713ms |
| Successful response sizes | All 5,912 returned 20 items |
| Candidate counts in persisted requests | All 5,912: tag 80, latest 40, quality 20, discovery 20 |

Admitted latency includes all 19 timed transport failures; HTTP-response latency
excludes them because they have no HTTP status. Cap rejections have no HTTP
latency and remain failures. Percentiles sort each stated population and use
zero-based `floor(n*p)`. The original capitalized PxxMS fields combine cap
rejections' zero durations and transport failure durations; they are retained
unaltered, not presented as response percentiles. The generator records only
`transport_error`, so the exact underlying client error subtype cannot be
reconstructed and is not asserted here.

The nominal schedule was never adjusted. Actual dispatch lag was p95 1.367ms,
p99 501.253ms and maximum 587.835ms; the final dispatch was 501.294ms after its
nominal time. These measured scheduler delays are retained. There was no
coordinated-omission correction or retrospective replacement of arrivals.

| Earlier retained run | HTTP p95 / p99 | Offered errors |
| --- | --- | --- |
| `bc29a66` (before recall/ranker optimization) | 2,573.884 / 3,071.013ms | 421/6,000 = 7.0167% |
| `8ec38e7` (optimized, before later governance/privacy/session changes) | 97.533 / 280.198ms | 19/6,000 = 0.3167% |
| This run `ebda1f9` | 129.821 / 2,054.024ms | 88/6,000 = 1.4667% |

Earlier evidence remains unchanged. These runs have different code and
observation overhead; the comparison alone does not identify the cause of the
remaining failure or of the difference between the last two runs.

## Bounded correlation of existing observations

There are 600 Go/PG resource observations, including two explicit observer
failures, and the complete external Docker/host stream. Six groups contain
failures or responses above 800ms. Three groups contain all 88 failures:

| Failure start/end UTC | Cap rejections | Transport failures | Associated slow-request span (seconds after start) |
| --- | --- | --- | --- |
| 05:53:13.331278–05:53:14.931287 | 8 | 0 | 462.702–466.926 |
| 05:55:05.832330–05:55:06.032317 | 3 | 0 | 574.301–577.795 |
| 05:55:11.931259–05:55:22.731335 | 58 | 19 | 581.100–594.272 |

The span includes earlier admitted slow requests as well as rejected arrivals;
transport failures end later than their start. `latency-clusters.json` retains
request indices and nearby resource observations for each group.

- Whole-run process CPU, including handler, request generator and in-process
  observer, was 150.302 CPU-seconds; max RSS 47,480,832 bytes. The one-second heap
  maximum was 18,049,104 bytes (the original report's less frequent heap sample
  maximum was 7,455,688 bytes). Peak observed goroutines: 140. Cumulative GC pause
  increase between first and last resource samples: 712.133ms; the largest
  adjacent-sample pause increase was 30.063ms. These are sampled diagnostics,
  not a server-only profile.
- Within the last slow group, sampled process CPU increased only 1.052s over
  11.881s and cumulative GC pause increased 17.389ms. The observations do not
  show a multi-second Go stop-the-world GC pause. They do not identify whether
  the process was waiting on the database, host scheduling or another cause.
- No ungranted PostgreSQL lock was observed in any successful sample. The failure
  groups show active work, `ClientRead` waits including idle-in-transaction
  connections, and occasional `WalSync`. This sampling cannot exclude shorter
  lock waits. At offsets 587.005s and 588.031s the bounded PG observer failed;
  observed elapsed time was 983.206ms and 715.887ms despite its 700ms context
  deadline, which also depends on scheduling and driver cancellation.
- In the last slow group, successful samples' cumulative PG block-read time
  increased 8.049ms and block-write time 85.859ms. PG logs show the scheduled
  checkpoint completing at 05:55:13.398Z (270.336s overall, 0.204s sync) and
  cancellation errors at 05:55:19–20Z in several API queries. The log has no
  per-request successful-query timing that would prove checkpoint causation.
- Host `vm_stat` lines were received at 05:55:09.094Z and next at
  05:55:17.883Z, an 8.789s output gap. Nearby lines include increased compression,
  page-in and swap activity; another burst coincides with the first failure
  group. These timestamps mark observer receipt of output, not kernel event
  timestamps. They cannot prove host pressure caused API failures, identify
  an offending process, or distinguish a delayed observer from a system stall.
- Within the measured request window the Docker stream reported PostgreSQL CPU
  p50 64.09%, p95 104.85%, and maximum 331.66%, including values above its 2-CPU
  configured limit. These raw Docker interval values are retained without
  treating them as reliable quota utilization or proof of a limit violation.
  Each container also had one `--` CPU sample, recorded as unavailable. The
  complete external stream extends beyond the load; only request-window samples
  enter the summary. Raw records outside that window are preserved separately.

**Root cause remains unresolved.** Existing observations support temporal
correlation, not attribution to host resource competition, PostgreSQL checkpoint
or a specific query. The next useful bounded diagnostic would record per-stage
API/database duration and pool wait, exact client error subtype, a short Go
execution trace, and Docker VM cgroup CPU/throttling/pressure counters during a
short reproduction on a quiescent controlled host. That work requires a separate
run; it was not substituted for or added to this single acceptance run.

## Deletion recovery after the load

On resume at 2026-09-08T16:45:41.368212Z, the completed load file and stopped
processes were checked first. A single existing bounded deletion phase then ran
for 6.395s on the retained synthetic fixture. Its later writes cannot change the
saved load report; the exact report hash is identical before and after cleanup.

- Observed an active real cascade, canceled its HTTP request, waited for row-lock
  rollback, and verified all 250,000 events and the original generation remained.
- Retried the authorized deletion once: HTTP 202/queued in **2,882.593ms**;
  250,000 events removed. This is above the 800ms normal Feed latency target,
  while remaining below the gateway's six-second timeout in this sample. The
  synchronous cascade remains a separate capacity boundary; this report does
  not generalize it to higher per-user event volumes.
- Confirmed old-generation archive reads failed immediately. Injected an actual
  unavailable S3 endpoint, persisted the failure, reopened the adapter and
  resumed from durable state. Cleanup completed in three bounded steps, one
  processed object, one recorded failure. Recreated profile version 2 could not
  resurrect the erased archive.

`delete.json` has zero load counters because it is a separate deletion phase;
its `deletion` object is the evidence. The deliberate canceled deletion's
transport failure is separate from the 19 load failures. This is cleanup recovery,
not a backup snapshot restore, and contains no taxonomy-proposal load fixture.

## Retention, cleanup and handoff

`load-original.json.gz` decompresses byte-for-byte to the original `load.json`,
SHA-256 `5980f917e6c063dc698fded9b3bd6586f058d1f3e2950569d6434a0592201227`.
Extracted observations, resource samples and raw external output are compressed
with fixed gzip mtime; original logs, schema, environment and query plans are
also retained. `SHA256SUMS` covers the retained files; `manifest.json` records
source, artifact and tool identities. To recompute the summary, decompress the
original load/external files into a temporary report directory, copy the other
inputs there, then run `scripts/summarize-feed-capacity.py` with that source and
a different destination. No database or load process is required.

Both exclusive capacity containers, their network and database volume were
removed by the capacity compose project; verified at
2026-09-08T16:47:14.589261Z. `cleanup.json` records absence and preservation of the
other ghfind containers. No remote resource, production data or traffic changed.

The next stage receives reproducible local failure evidence, not permission to
cut traffic. Required remaining gates include diagnosis and a newly authorized
successful reliability run, CF staging latency/cold-start/capacity/cost evidence,
real OAuth and asynchronous E2E, and independent migration/backup restoration.
