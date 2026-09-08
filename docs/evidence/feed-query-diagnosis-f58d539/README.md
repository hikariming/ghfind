# Runtime query diagnosis, 2026-09-08 UTC

This is bounded local PostgreSQL diagnosis, **not a capacity pass, Linux reproduction, Cloudflare test, or real OAuth evidence**. The failed Linux capacity run at `1bc35c368a5b73a353d3b07234be653ce7cc3ac4` remains a release blocker. No 600-second load was repeated.

## Frozen code and limits

- Initial diagnostic source: `f58d539dd40291b3d30fb3c64b64ec26c464de06`, clean checkout; binary SHA256 in `initial-100/manifest.json`.
- Driver metadata correction: `042ba51`; independent two-request regression: `6dc60d849c3a6a7d416b0e25feae07f66a0b2cc5`, clean checkout; test binary SHA256 in `two-request-regression/manifest.json`.
- One fresh synthetic seed: 50,000 projects and matching source receipts/assessment evidence, 5,000 users, 1,000,000 whitelisted events, 100,000 project tags. No historical data was promoted or imported. Seed took 45.715 seconds.
- The seed invocation **mistyped the full baseline SHA**. Its original `fixture.json` is preserved unchanged. `initial-100/manifest.json` records the erroneous argument and actual source/binary identity. This disqualifies the fixture report as exact-release acceptance metadata; it does not conceal or rerun the attempt.
- The dedicated PostgreSQL instance used port 55441, database `feed_query_diagnose_test`, 2 CPU and 2 GiB memory. Go ran on macOS arm64; PostgreSQL ran linux/arm64 under local Docker. Existing shared PostgreSQL/MinIO/API containers were untouched. No MinIO, queue, OAuth or remote resources were used.
- Original diagnostic CLI: at most 100 sequential HTTP requests, 5 seconds each; first 80 seconds allocated to requests, total 120 seconds including initialization and EXPLAIN, 2 seconds per plan. Independent regression was explicitly limited to **two** HTTP requests and a **20-second** context covering dependency checks and EXPLAIN. It did not rerun the 100-request phase or seed.

## Preserved results

| Run | Actual HTTP | Duration | Plan capture | Outcome |
| --- | --- | --- | --- | --- |
| Initial diagnostic | 100 attempted, 100 HTTP 200 with 20 items, zero cancelled | 11.975 s | Zero: driver format metadata was rejected by the exemplar copier | `incomplete`, exit 1 |
| Dedicated correction regression | 2 attempted, 2 HTTP 200 with 20 items | 0.466 s | All 8 runtime templates × 2 synthetic user cohorts, 16 successful EXPLAINs | Regression passed; **not complete CLI/capacity acceptance** |

The initial query trace is valid even though plan capture failed. pgx stdlib prepends `QueryResultFormatsByOID` before bind parameters, and tracing happens before pgx consumes that metadata. The copier originally rejected this argument shape. The fix strips only recognized leading result-format options; it still rejects unsupported bind payloads and metadata appearing among actual arguments. A regression covers the real driver shape and defensive cloning of array arguments.

The initial diagnostic reports all outcomes and unobserved plans rather than treating successful HTTP responses as successful diagnosis. The original files and their mistakes are immutable evidence in this directory.

## What the actual runtime trace shows

These are cumulative times across 100 sequential requests; parent/child stages overlap and must not be added together.

| Stage or SQL template | Total ms | Meaning |
| --- | ---: | --- |
| Candidate loading, entire operation | 7,662.469 | Recall plus hydration |
| `candidates.tag` | 6,706.775 | Actual runtime tag SQL, including row consumption |
| `session.put` | 1,765.958 | Snapshot serialization and guarded transaction |
| `request.record` | 1,148.379 | Identity/eligibility guard and serving-record transaction |
| `candidates.tags` | 344.908 | Current-analysis canonical tag hydration |
| `snapshot.available` SQL | 277.036 | Identity-aware availability check |
| `candidates.hydrate` | 222.465 | Project, state and impression hydration |
| `candidates.latest` | 142.864 | Latest recall |
| `candidates.discovery` | 121.593 | Long-tail recall |
| `candidates.quality` | 117.747 | Quality recall |
| `snapshot.eligible` | 73.561 | Final request transaction eligibility check |

The full trace also retains fingerprint, duration and outcome for write/locking/unregistered statements. It does not emit those statements or their arguments. Resource samples and dedicated PostgreSQL Docker samples are retained with timestamps; this short sequential run cannot reproduce sustained Linux CPU saturation.

## What the corrected actual-template plan shows

Both user cohorts take the same costly shape inside the tag recall `sampled` CTE:

1. Under the per-preference `LIMIT 160`, PostgreSQL performs a `Sort` over a `Hash Join`.
2. `project_tags` is sequentially scanned twice; each loop returns 50,000 rows and filters another 50,000 rows.
3. The current-project side scans and hashes 50,000 projects, despite only 160 returned candidates per preference.
4. This CTE takes 59.298 / 56.917 ms, versus 62.512 / 59.965 ms for the full tag query. Root shared-buffer hits are 13,090 / 13,084; sampled-subtree hits are 9,567 / 9,564.

The plans come from the **exact serving query templates and captured in-memory arguments**, executed on a separate read-only connection. They are not the original runtime prepared statement and do not prove which warmed generic plan Linux used. Trace durations are actual runtime observations; these EXPLAIN plans independently demonstrate unnecessary full-catalog work for the selected fixture parameters.

The prior capacity harness's hand-maintained plans omitted the current-analysis join, canonical negative preference filters, and revoked evidence checks. Its millisecond-scale numbers cannot explain current serving behavior. The seed phase no longer emits those simplified plans; historical files remain intact.

## Next minimal correction to evaluate

Keep current-analysis eligibility **before** the existing `ORDER BY ... LIMIT 160`, but replace its one-to-one project join with a correlated `EXISTS` probe protected by `OFFSET 0`. The project primary key guarantees at most one match; a matching current analysis is still required, including the same NULL behavior. This could let the existing tag weight/order index serve the bounded scan without a full-catalog hash join. It is a proposed change, **not implemented in these commits**.

Before accepting it: compare actual result keys, affinities and candidate counts with the original query on current/stale analysis and sparse/dense tag fixtures; retain negative preference, provenance, taxonomy, ranking and session tests. Capture the modified runtime plan and bounded trace, including Linux prepared-plan behavior when available. Only a later separate full-capacity run may resolve the production SLO gate.

## Reproduction and artifact safety

The normal entry point is `cmd/feed-capacity -phase diagnose -baseline <git rev-parse HEAD> -out <new directory>`, using `FEED_CAPACITY_DATABASE_URL` with an explicitly owned loopback `*_test` database. It requires the existing synthetic fixture marker and does not create or reset tables.

The narrowly scoped regression is `go test -tags feeddiagnostic ./cmd/feed-capacity -run '^TestDiagnosticPostgresTwoRequests$' -count=1`, with explicit `FEED_DIAGNOSIS_TEST_DATABASE_URL`, `FEED_DIAGNOSIS_TEST_BASELINE` and a fresh `FEED_DIAGNOSIS_TEST_OUT`. It never seeds and refuses overwriting its evidence file.

Only exact registered read-only runtime templates can reach EXPLAIN; tests prove INSERT/UPDATE/unknown SQL and an appended second statement never reach the execution dependency. Templates preserve the pre-refactor SQL byte-for-byte via fixed SHA256 regressions. Values remain in memory, plan expression fields are removed, and error messages are reduced to fixed categories/PostgreSQL codes. The artifacts contain no DSN password, gateway token, raw user request body or SQL bind argument.

Validation: `go test ./...`; `go test -race ./cmd/feed-capacity -run Diagnostic -count=1`; one real two-request PostgreSQL regression. The dedicated integration test is now isolated behind the `feeddiagnostic` build tag and fails if its explicit fixture DSN is missing. Default `go test ./...` does not compile or execute that tagged test. The historical successful `6dc60d8` run predates this packaging change; its exact command remains unchanged in the manifest. This test does not replace mandatory storage contracts or the Linux diagnostic workflow.
