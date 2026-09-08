# Local capacity baseline: failed

Source baseline `bc29a66`; harness `b8900e7`; 2026-09-08. This is local synthetic
PostgreSQL evidence, not CF, real OAuth, or production acceptance. PostgreSQL used
2 CPUs / 2 GiB with a dedicated disk volume. Go API and generator shared the host.

The fixture had 50,000 eligible synthetic projects, 5,000 users, and 1,000,000
whitelist events (747,861,683 database bytes before load). Every project had
synthetic submission/assessment linkage and approved taxonomy tags. There was no
historical import or automatic provenance reassignment.

| Measurement | Observed |
| --- | --- |
| Scheduled arrivals | 6,000 over 600.414 s, 10/s offered |
| Successful HTTP responses | 5,579 HTTP 200 |
| Rejected by fixed 20-in-flight bound | 421 (7.0167%) |
| Actual HTTP p50 / p95 / p99 | 696.540 / 2,573.884 / 3,071.013 ms |
| Actual HTTP maximum | 3,588.367 ms |
| Go API + generator CPU / maximum RSS | 1,175.160 CPU seconds / 45,465,600 bytes |
| Sampled Go heap maximum | 14,294,536 bytes |
| PostgreSQL sampled CPU range | 104.08–201.58% (2-CPU cap) |
| Candidate source counts | tag 80, latest 40, quality 20, discovery 20 |

The 800 ms target failed, and admitted throughput was below the offered 10/s
because the concurrency budget was exhausted. Do not describe this as sustained
10 successful HTTP requests/s. There were no HTTP errors among admitted calls;
the failure classification includes rejected arrivals.

The raw harness P* fields included rejected arrivals with zero latency. The
`httpLatencyMs` fields in `load-summary.json` recompute percentiles for actual
HTTP responses. `observations.json.gz` retains all 6,000 observations, including
rejections. The summary retains all 19 raw PostgreSQL Docker metric samples.

EXPLAIN showed latest/quality/discovery scanning all 50,000 project and evidence
rows with hash joins and sorting, about 36–39 ms each in the isolated pre-load
plan measurement. Tag recall was 2.38 ms and the indexed high-volume impression
query 0.023 ms. These measurements motivate a separate optimization; they do not
establish that PostgreSQL alone accounts for the complete API latency.

The high-volume user's 250,000-event deletion returned 202/queued in 938.912 ms.
Cancellation was injected after observing the actual cascade query; rollback
preserved the original event count, generation, and absence of a tombstone. The
successful deletion immediately left zero events for that actor. A real S3
connection failure persisted one cleanup failure; reopening the database adapter
resumed cleanup in three steps and erased one registered object. Cleanup status
was completed and recreation advanced profile version to 2; the old archive
remained fenced. This verifies this fixture's deletion boundary, not arbitrary
larger user histories or a backup restore.

The load binary was built while the harness was being developed; its load path
is unchanged in `b8900e7`. The deletion binary was rebuilt with the final explicit
cascade-observation and durable recovery checks. Both exact executable hashes and
all evidence file hashes are retained in `manifest.json`. Reproduction commands
are in `docs/operations/feed-local-capacity.md`.
