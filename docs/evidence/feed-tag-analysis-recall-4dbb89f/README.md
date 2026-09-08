# Current-analysis tag recall correction

This packet is separate from the earlier incomplete 100-request diagnosis and successful two-request capture regression. It contains **eight read-only SQL executions on the same synthetic PostgreSQL fixture**, with no new seed, HTTP requests, 100-request diagnosis, or 600-second load. The 30-second comparison budget was respected: actual duration was 0.332 seconds.

The comparison executable was built from clean source `4dbb89fe1ea5c014b9649ce40a6bb1adaae05d73`. The immutable test binary hash and exact command appear in `manifest.json`. Variant 0 is the original runtime query; variant 1 replaces only its current-analysis project join with a correlated `EXISTS (... OFFSET 0)`. Both retain identical preference selection, candidate filtering, ordering and limits. The implemented change is identified separately in `implementation.json`.

| Cohort | Original SELECT ms | Proposed SELECT ms | Original EXPLAIN execution ms | Proposed EXPLAIN execution ms | Shared hits, original → proposed |
| --- | ---: | ---: | ---: | ---: | ---: |
| High-event synthetic user | 122.064 | 5.041 | 57.319 | 2.833 | 13,084 → 3,376 |
| Ordinary synthetic user | 47.486 | 3.605 | 59.307 | 2.840 | 13,084 → 3,376 |

For both cohorts, all **80 ordered repository keys and exact float64 affinities** are identical. Their ordered-result SHA256 is `a247431ce53fffefafdd43a4e428c1e7687e70c41a0631585a9f22ccfe557b54`. Equality was checked on full rows in memory, not inferred from the hash or total count.

The original plan scans 100,000 tag rows twice (50,000 returned and 50,000 filtered per loop), scans/hashes 50,000 projects, and sorts before returning 160 candidates per preference. The proposed plan uses `project_tags_recall_affinity`, reading 160 rows per preference with two loops and 320 current-project primary-key probes. The full-catalog hash join is absent. Eligibility is checked before the fanout limit, and the project primary key makes the existence test equivalent to the prior one-to-one join.

The implementation changes only that predicate. It does not alter the tag weight expression, existing tie ordering, per-preference 160 bound, aggregate Top80, provenance/revocation checks, negative preferences, taxonomy rules, owner cap, exploration or propensity policy. Other runtime SQL must still match the pre-refactor `1bc35c3` fingerprints after mechanically reversing this one documented predicate replacement.

A separate small database on the owned local PostgreSQL instance exercised 180 synthetic projects, stale high-weight tag sources sufficient to fill the fanout, current equal-weight sources sharing a repository, an equal-weight multi-source tie at the 160th row, and a weak negative preference producing nontrivial affinities. Original and proposed queries returned identical ordered keys and affinities. The regression also checked revoked evidence, not-interested state, unpublished projects, explicit canonical negative filtering, canonical deprecation, and absence of stale tags from hydration. Existing governance taxonomy/current-analysis contracts passed against this real database with `FEED_REQUIRE_POSTGRES_TESTS=1`.

This local arm64 comparison does not establish Linux generic-plan behavior or capacity compliance. EXPLAIN is a separate execution of the exact query and fixture parameters; it does not reuse a warmed runtime prepared plan. Linux baseline diagnosis and an independently gated later capacity run remain necessary. The historical Linux failure is still a production rollout blocker.

Reproduction of the dedicated comparison is explicitly opt-in: `go test -tags feeddiagnostic ./cmd/feed-capacity -run '^TestDiagnosticTagAnalysisCompare$' -count=1`, with an existing owned synthetic fixture, `FEED_DIAGNOSIS_TEST_DATABASE_URL`, exact `FEED_DIAGNOSIS_TEST_BASELINE`, and a fresh `FEED_DIAGNOSIS_TEST_OUT`. It executes exactly two SELECTs plus two EXPLAINs per cohort in a read-only transaction and refuses overwriting evidence. Missing explicit database configuration fails; default Go tests do not include the tagged diagnostic harness.

The bounded comparison selected only static original/proposed templates and controlled synthetic users. No arbitrary SQL RPC, DDL, raw input, password or SQL bind parameter is present in the artifacts. Plan expressions are redacted. `SHA256SUMS` covers the preserved files; gzip decompression reproduces the original report bytes.

Cleanup completed: the sole owned `ghfind-query-diagnose-pg` container and `ghfind-query-diagnose-pg-data` volume were removed after the comparison and small-fixture tests. `cleanup.json` records exact commands/results and absence checks. The source baseline reports remain preserved; no background workload remains.
