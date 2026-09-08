# Reproduce the local PostgreSQL capacity check

This harness measures the portable Go API against a disposable local pgvector
PostgreSQL database. It does not establish Cloudflare latency, Container cold
starts, paid account eligibility, real GitHub OAuth, assessment execution, or
production readiness. Gateway claims use the same verified HMAC contract with
explicit fixture-only secrets. Every measured GET creates a new Feed snapshot;
there is no application response-cache hit path. PostgreSQL's buffers may warm
while loading/analyzing the fixture, as documented by the query plans.

The database URL must use a loopback host and a database name ending `_test`;
connection overrides such as `?host=` or `?dbname=` are rejected. Seeding refuses
an existing application database and never drops tables. Load/delete require a
persistent `synthetic-capacity-v1` ownership marker. Use only this Compose project;
do not point it at an existing development, staging, or production database.

The fixture contains 50,000 `capacity-owner-*/synthetic-project-*` projects,
5,000 `capacity-user-*` users, and 1,000,000 UUIDv4-shaped whitelist events.
Synthetic receipt/assessment fixture tables link every eligible project to a
current completed synthetic assessment and `app_submission` evidence. This is a
relational test fixture, not a claim that the production submission/assessment
pipeline ran. Existing approved `artifact:micro-tool` and
`stage:active-evolution` tags are reused; no historical or unknown project is
reclassified. Events link to their actor's served request and project, contain
only `rank` and `algorithmVersion` metadata, and are 14–15 days old. One user owns
250,000 events; the other users share 750,000. The skew is an intentional deletion
stress case, not an assertion about normal user behavior.

PostgreSQL is capped at 2 CPUs and 2 GiB RAM, with a separate disposable disk
volume. The Go HTTP handler and load generator run together on the local host;
their combined CPU, RSS, and sampled heap are reported. This is not an isolated
CPU measurement of Go alone. Docker CPU/memory samples refer only to the named
PostgreSQL container. The capacity MinIO is separate on port 59002; it is used
only for the deletion recovery check.

```sh
docker compose -p ghfind-feed-capacity -f ops/feed-capacity-compose.yaml up -d
export FEED_CAPACITY_DATABASE_URL='postgres://postgres:capacity-local-only@127.0.0.1:55441/feed_capacity_test?sslmode=disable'
export FEED_CAPACITY_S3_ENDPOINT='http://127.0.0.1:59002'
export FEED_CAPACITY_S3_ACCESS_KEY_ID='capacity-local'
export FEED_CAPACITY_S3_SECRET_ACCESS_KEY='capacity-local-only-password'
go build -o /tmp/ghfind-feed-capacity ./cmd/feed-capacity
/tmp/ghfind-feed-capacity -phase seed -baseline <verified-source-sha> -out /tmp/feed-capacity-report
/tmp/ghfind-feed-capacity -phase load -baseline <verified-source-sha> -pg-container ghfind-feed-capacity-postgres-1 -out /tmp/feed-capacity-report
/tmp/ghfind-feed-capacity -phase delete -baseline <verified-source-sha> -out /tmp/feed-capacity-report
```

The displayed credentials are dummy credentials for this isolated fixture.
The load phase schedules exactly 6,000 requests at 10 requests/second for at
least 600 seconds. Each request has a five-second timeout. At most 20 requests
are in flight; hitting the cap is recorded as an error, never hidden by lowering
the arrival rate or extending the timeout. The trace records response status,
latency including body read, and item count. p50/p95/p99, total error rate,
request candidate-source counts, process CPU/RSS/heap, and database Docker stats
are included in `load.json`. Requests rejected by the concurrency cap have no
HTTP latency; their zero trace latency must not be confused with a successful
response. Judge both latency and error rate, not percentiles alone.

`fixture.json` records cardinalities and footprint. `query-plans.json` contains
actual `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output with the explicit recall
SQL and high-volume user impression query. Compare plan shapes and rows scanned,
not only reported milliseconds. Later SQL versions need their own plans.

The delete phase first observes the real `DELETE FROM feed.users` cascade in
`pg_stat_activity`, then cancels the HTTP request and waits for row-lock rollback.
It verifies that the original events, generation, and absence of a deletion
marker survive. It then times an accepted DELETE, checks 202/queued and immediate
removal, injects an actual unavailable S3 endpoint during cleanup, persists the
failure, reopens the PostgreSQL adapter, and resumes the bounded cleanup. A new
profile generation must not read the erased old archive. `delete.json` records
these results; a failed injection or cleanup remains a failure rather than being
reported as completed.

After preserving the evidence, remove only this exclusive fixture:

```sh
docker compose -p ghfind-feed-capacity -f ops/feed-capacity-compose.yaml down -v
```

This removes the capacity project's own synthetic database volume and MinIO
container. It does not address backup restoration, which requires a separate
snapshot/import/replay/fencing exercise.

For bounded CPU diagnosis, run `-phase profile` separately. It sends at most100
sequential requests over at most90seconds and writes `api-cpu.pprof`; inspect with
`go tool pprof -top -cum /tmp/ghfind-feed-capacity /tmp/feed-capacity-report/api-cpu.pprof`.
This is a diagnostic sample, not another ten-minute acceptance run. Keep the
binary used for the profile until it has been inspected.

The original baseline query named `high_user_impression` targeted project00000,
which has only detail-open events. Its plan measured an index miss. The corrected
`high_user_impression_hit` targets project00001 (25,000 impressions). The original
trace remains unchanged; the optimized evidence includes a separately measured
corrected plan on the same regenerated fixture.

For a run investigating short stalls, the load report also records each request's
nominal arrival, actual start/end offset and in-flight count. Once-per-second
Go/PG observations include cumulative process CPU and GC pauses, sampled heap,
connection wait categories, I/O timing and ungranted lock counts. The observer has
a 700ms deadline and records its own elapsed time and failures. It does not log
SQL, user IDs or credentials, and does not alter admission or timeout limits.
These extra observations have overhead; record the instrumentation commit beside
the frozen business source SHA when comparing runs.

`scripts/observe-feed-capacity.py --out <new-report-directory> --stop-file
<run-stop-file>` optionally records continuous Docker statistics for only the two
capacity containers and host `vm_stat` counters with UTC timestamps. It stops at
the marker or after 720 seconds and terminates its children. Start it immediately
before load and create the marker when load finishes. Host/VM observations can
locate a coincident stall; they do not by themselves prove its cause. Do not run
other local integration/load tests during the measured ten-minute interval.
