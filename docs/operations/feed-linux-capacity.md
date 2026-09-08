# Isolated Linux capacity evidence

The `Feed isolated Linux capacity` workflow runs the portable Go HTTP handler
against a fresh loopback PostgreSQL/pgvector and MinIO fixture on one GitHub
Actions Linux runner. It is the next controlled observation after the retained
[writer-2 local reliability failure](../evidence/feed-capacity-ebda1f9/README.md).
The [clock interpretation review](../evidence/feed-capacity-clock-review/README.md)
records an observed wall/monotonic discrepancy in that run. Changing the host is a separate experiment; a Linux result cannot retrospectively
explain or erase the macOS failure.

The workflow accepts one exact 40-character commit already on `main` with
successful required CI. It has read-only repository and Actions permissions and
uses only fixed synthetic credentials. It does not access Cloudflare bindings,
production databases, real OAuth identities or assessment providers. Its maximum
job duration is 30 minutes. PostgreSQL remains capped at 2 CPUs and 2 GiB; MinIO
at 0.5 CPUs and 512 MiB. The handler and load generator share the runner process,
so their CPU/heap measurements are combined. The image digests, binary checksum,
source SHA, Go version and runner resources are retained with each report.

Once this workflow has been merged and the chosen commit has passed CI:

```sh
gh workflow run feed-capacity.yml --ref main -f release_sha=<verified-main-sha>
```

The immutable fixture contains 50,000 projects, 5,000 users, 1,000,000 events and
50,000 submission receipts. One actor owns 250,000 events for the bounded
deletion/rollback test. The load offers 6,000 requests at 100 ms intervals over
at least 600 seconds, with at most 20 requests in flight and a five-second HTTP
deadline. Each measured GET creates a new Feed session. There are no input knobs
to reduce the fixture, lower the offered rate or relax the deadline.

After the load, the same job exercises cancellation during a real deletion
cascade, verifies transaction rollback, accepts deletion, injects an actual S3
failure, reopens the adapter and resumes cleanup from its persistent checkpoint.
The new report must identify the observed injected failure and its durable state;
a cleanup-failure counter alone is insufficient. This tests deletion recovery,
not backup restoration or object transfer to a recovery database.

`scripts/verify-feed-capacity.py` independently recomputes the gate from
`fixture.json`, every observation in `load.json`, and `delete.json`. It verifies
the common source SHA and exact fixture/arrival counts. All rejected admissions
and transport failures remain in the offered-request error denominator. Rejected
admissions have no HTTP latency and are excluded from latency percentiles;
admitted transport failures remain included. A passing engineering gate requires
error rate ≤0.1% (at most 6 of 6,000) and admitted p95 ≤800 ms, as well as complete
deletion-recovery evidence. This finite-run gate does not statistically establish
monthly 99.9% availability or Cloudflare server latency.

Execution quality also requires the fixed schedule, at most 1,000 ms dispatch
lateness and at least 550 valid one-second Go/PostgreSQL observations. Missing or
malformed evidence fails closed. Percentile definitions and population counts
are recorded in `gate.json`; never substitute the legacy capitalized Pxx fields,
which include zero-latency admission failures.

All steps are bounded. There is one load attempt per dispatch, with no automatic
rerun or profile phase. A load-step failure remains a failed workflow even if the
independent deletion check succeeds. Reports, including failed gates, are kept in
an Actions artifact for 30 days. Download and retain meaningful results before
that retention expires; this artifact is a public synthetic test report, not a
backup destination. Initial source/run metadata is written before preflight and
build; it is not proof that those steps passed. Build/test output and exit status
are retained even when they fail. A checkout failure is visible only in Actions
logs. Cleanup runs only if fixture startup was attempted after source verification;
it removes this job's named Compose project and its synthetic volume. A successful
run still leaves real CF lifecycle, bounded
staging load, measured cost, actual OAuth/assessment and production rollout gates
open.
