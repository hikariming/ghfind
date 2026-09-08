# Bounded diagnosis of actual Feed queries

The Linux capacity baseline at `1bc35c3` failed its latency and error gates. Its
historical `query-plans.json` contains simplified copies of older queries; it
does not cover all filters and joins in the actual runtime or hydration and
session persistence. Those historical artifacts remain unchanged. Do not use
their short timings to conclude that the current request's queries are fast.

`Feed isolated Linux query diagnosis` runs the exact portable handler on a new
synthetic PostgreSQL/pgvector fixture. It requires an exact main SHA that has
passed required CI, read-only GitHub permissions and no Cloudflare or production
secrets. The fixture, database/storage image pins and resource limits match the
capacity fixture: 50,000 projects, 5,000 users, 1,000,000 events; PostgreSQL 2 CPU
and 2 GiB. The signed gateway fixture does not prove real GitHub OAuth.

After this workflow and its matching harness are merged and their SHA passes CI:

```sh
gh workflow run feed-diagnose.yml --ref main -f release_sha=<verified-main-sha>
```

The separate `diagnose` phase permits at most 100 sequential requests, five
seconds per request and a 120-second phase deadline. It captures timings for
actual runtime SQL and bounded execution plans for registered read operations.
Write operations are observed, not replayed with EXPLAIN. Diagnostic output must
omit bind parameters, credentials and raw event or identity payloads; fixture
identifiers in execution plans are synthetic. Deadline exhaustion remains an
incomplete diagnostic result. The workflow does not create a passing capacity
gate, perform the 600-second load or replace any failed report.

CPU/database observations can guide investigation but do not establish a specific
query's causality. Compare the actual query stages and execution plans, validate
a repair without relaxing Feed semantics, then rerun the separate full capacity
gate on the repaired exact main SHA after CI. This diagnostic workflow has one
attempt, retains evidence for 30 days including failures, and always removes its
own Compose project. Retain meaningful reports before Actions artifact expiry.
Source/run metadata is created immediately after checkout; build/test failures
retain their logs and exit result before fixture creation. Checkout failure itself
has only the Actions execution log. Individual step deadlines and a 25-minute
job ceiling reserve time for upload and cleanup. Cleanup interprets the repository's
Compose file only after the verified-source fixture step actually ran.
