# Local capacity after optimization: latency passed, reliability incomplete

Frozen source and harness `8ec38e7b8d39465d5205b30affbc12914a807a14`, 2026-09-08.
This repeats the prior local PostgreSQL synthetic fixture and offered load. It
is not Cloudflare, Container cold-start, real OAuth, cost, or production evidence.
The business algorithm remains `baseline-v2-portable`; three pre-optimization
complete ranked-output golden fixtures also pass under Go 1.26.1 on macOS and the
pinned Go 1.23 Linux image.

| Measurement | Baseline bc29a66 | Optimized 8ec38e7 |
| --- | --- | --- |
| Projects / users / events at start | 50,000 / 5,000 / 1,000,000 | same |
| PostgreSQL cap | 2 CPUs / 2 GiB | same |
| Offered requests / duration | 6,000 / 600.414 s | 6,000 / 600.090 s |
| HTTP 200 responses | 5,579 | 5,981 |
| Concurrency rejections / rate | 421 / 7.0167% | 19 / 0.3167% |
| HTTP p50 / p95 / p99 | 696.540 / 2,573.884 / 3,071.013 ms | 53.320 / 97.533 / 280.198 ms |
| HTTP maximum | 3,588.367 ms | 3,876.686 ms |
| Go API + generator CPU | 1,175.160 s | 139.571 s |
| Go maximum RSS | 45,465,600 bytes | 44,417,024 bytes |
| Sampled heap maximum | 14,294,536 bytes | 15,569,096 bytes |
| PostgreSQL sampled CPU | 104.08–201.58% | 14.23–33.86% |
| Candidate sources per request | tag 80/latest 40/quality 20/discovery 20 | same |
| Database size before load | 747,861,683 bytes | 753,727,155 bytes |
| Accepted 250k-event deletion | 938.912 ms | 1,024.146 ms |

All 5,981 admitted HTTP calls returned 200 and 20 items. The 19 rejections clustered
at scheduled seconds 259.6–261.4, when 20 calls already occupied the in-flight bound.
Nearby admitted calls took up to 3.877 s. The 800 ms p95 target passed; the whole run
must not be described as a reliability pass or 10 successful requests/s.
The 0.3167% offered-request error rate also exceeds 0.1%; a ten-minute load test
cannot establish monthly 99.9% availability. Root cause of the short stalls is
unresolved. PostgreSQL logs contain ordinary checkpoints, without a diagnostic
error in the stall interval; 30-second CPU samples do not explain short stalls.
Keep this result and add request-stage/host/lock-wait tracing before any further
bounded validation instead of silently increasing concurrency or timeouts.

The optimization reuses each candidate's maximum similarity to the growing
selected prefix, reducing similarity pair evaluations from cubic to quadratic.
The captured 240-candidate microbenchmark changed from 707.36 ms/op to 18.52 ms/op.
Portable PostgreSQL evidence checks remain correlated index probes; the quality
path has an additive index matching its exact deterministic order. No eligibility
or negative filter is applied after the source LIMIT. Real PostgreSQL regression
coverage puts 90 invalid/blocked/unpublished rows ahead of 40 valid rows and verifies
full recall, then verifies short recall when only 5 valid rows remain.

| Isolated pre-load EXPLAIN | Baseline | Optimized |
| --- | --- | --- |
| latest | 36.519 ms, 50k project/evidence scans | 0.448 ms, 40 project/evidence probes |
| quality | 38.082 ms, 50k project/evidence scans | 0.672 ms, 20 project/evidence probes |
| discovery | 39.279 ms, 50k project/evidence scans | 0.369 ms, 20 project/evidence probes |
| tag | 2.380 ms, bounded per-tag retrieval | 4.686 ms, same bounded retrieval |

These standalone plan times are not API latency measurements. Both versions
retain their exact SQL and raw plans. The database now includes root's additive
schema compatibility migration 0019 and the new quality index 0020; schema contract 1
remains compatible. No other implementation changed during the optimized run.
Seed time 75.548 s and the larger footprint are recorded rather than hidden.

Deletion cancellation was observed during the actual user cascade, and rollback
preserved all 250,000 events and the original generation. Successful deletion left
zero actor events and immediately fenced the old archive. A real unavailable S3
endpoint caused one persisted cleanup failure; reopening the adapter recovered
in three steps, cleared one object, and marked completed. Recreation advanced
to profile 2 and could not read the old archive. This exercises durable adapter
recovery, not a full process restart or backup restoration.

A separate post-deletion profile sent 100 sequential requests against the unchanged
50k catalog and 750k remaining events, matching the earlier diagnostic scope.
Wall time was 3.21 s, sampled CPU 0.89 s; ranker cumulative 7.87%, weighted Jaccard 1.12%
(compared with 89.76% and 81.16% previously). See the raw pprof and top output.
The API and generator share the host CPU; PostgreSQL has a separate Docker cap.

The earlier `high_user_impression` EXPLAIN used project 00000, which contains only
`detail_open` events. It measured an index miss, not retrieval from 25,000 matching
impressions. The raw baseline and optimized plan files are intentionally retained.
`impression-hit-query-plan.json` supplies a corrected read-only plan against
project 00001 on a separately regenerated identical fixture, after the deletion
exercise. It is additional query evidence and does not alter either load result.

`environment.json` records the clean source, binary and file hashes, exact image
identities and resource limits. `load-summary.json` derives HTTP percentiles from
received responses only; the compressed trace includes all 6,000 arrivals. No
rejection is hidden. The manifest hashes every retained evidence artifact.

The corrected hit probe matched 25,000 impressions and executed in 0.144 ms using the existing composite impression index.
