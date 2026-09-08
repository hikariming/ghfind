# Linux runtime-query diagnosis at 45d6427

This packet preserves the successful [Linux diagnostic run 34262883561](https://github.com/hikariming/ghfind/actions/runs/34262883561), attempt 1, job `102184979298`. It tested source `45d6427a22943d23ce3acb413cff20dd9f4ef61b` on `ubuntu-24.04`, before the current-analysis tag-recall optimization in PR255. This is a sequential synthetic diagnosis, **not capacity or production acceptance**. Preservation did not run another test, request workload, database operation, or Cloudflare operation.

All 13 original artifact files are retained unchanged, with lossless gzip for the three large reports. [manifest.json](manifest.json) records original and stored byte counts/hashes separately. The downloaded GitHub ZIP SHA256 was independently checked against artifact `10070704621`'s reported digest, and every ZIP entry matched the supplied local artifact bytes. The ZIP and executable are not retained; their identities are recorded. `build.log` is correctly preserved as an empty file, alongside the original successful `build-result.json`.

## Source, execution, and cleanup

Requested SHA, checked-out SHA, executable build provenance, fixture baseline, diagnosis baseline, and plan baseline all agree on `45d6427a22943d23ce3acb413cff20dd9f4ef61b`. The source's preceding [CI run 34262236855](https://github.com/hikariming/ghfind/actions/runs/34262236855) succeeded. The diagnostic job independently checked exact checkout, main ancestry, and successful CI before building and starting its fixture. API metadata and original log excerpts are preserved in [execution-evidence.json](execution-evidence.json) and [actions-source-cleanup.log](actions-source-cleanup.log).

The original [run.json](run.json) still says `source preflight not yet completed`: it was intentionally written before preflight and was never rewritten. It is an initialization record, not the final run verdict. The successful later preflight step, its actual `true` output, and exact checkout log provide the subsequent evidence. No original field was patched to manufacture completion.

The fixture contains 50,000 projects, 50,000 submission receipts, 100,000 project tags, 5,000 users, and 1,000,000 events. [fixture.json](fixture.json) also records seeded request/service counts and database size. [containers.txt](containers.txt) records the actual local image IDs and limits: PostgreSQL 2 CPU / 2 GiB, MinIO 0.5 CPU / 512 MiB. Image IDs are container image-config identities, not registry manifest digests. The executable is Go 1.23.0, Linux amd64; the source-pinned fixture configuration is [ops/feed-capacity-compose.yaml at the tested SHA](https://github.com/hikariming/ghfind/blob/45d6427a22943d23ce3acb413cff20dd9f4ef61b/ops/feed-capacity-compose.yaml).

After artifact upload, Actions successfully removed both fixture containers, the `capacity_data` volume, and the Compose network. The retained cleanup excerpt contains their actual `Removed` output; job step 11 independently reports success. Since cleanup happened after upload, its proof comes from Actions logs/metadata, not from the original artifact. No later independent runner readback is claimed.

## Verified diagnostic results

[summary.json](summary.json) recomputes request and trace statistics from the preserved observations. Percentiles use nearest rank. All 100 observations are HTTP 200 with exactly 20 items and no reported error. Total diagnosis duration was 18.67141728 seconds, within the configured 120-second bound. There were no cancelled or unattempted requests. Request p50 was 183.331 ms, p95 189.340 ms, maximum 237.367 ms; these values describe only this sequential run.

The reports contain 5,505 successful SQL traces: five initialization traces and 5,500 traces attached to requests, with zero dropped traces. All eight registered read templates were captured and explained for both synthetic cohorts, yielding 16 successful actual-query plans with no missing template/cohort. There are 500 business-stage timings and 18 internal resource samples. The unmodified external resource stream is preserved for inspection; this short diagnosis does not establish the 600-second observation-coverage gate.

The largest named SQL timings observed during actual request execution were:

| Runtime SQL template | Calls | Total ms | Mean ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| `candidates.tag` | 100 | 13,440.030 | 134.400 | 140.665 |
| `snapshot.available` | 100 | 443.738 | 4.437 | 5.306 |
| `candidates.tags` | 100 | 420.567 | 4.206 | 4.825 |
| `candidates.hydrate` | 100 | 234.000 | 2.340 | 2.974 |
| `candidates.latest` | 100 | 194.463 | 1.945 | 2.085 |

The complete ranking in `summary.json` also includes unnamed query fingerprints, without guessing their SQL. `candidates.tag` accounted for 79.204643% of the 16,968.740 ms summed request SQL timing, identifying the dominant measured SQL path in this run. Its separate EXPLAIN execution times were 153.725 and 141.735 ms for the two cohorts. Business stages overlap SQL timings: the candidate stage totaled 14,588.970 ms, session storage 1,056.381 ms, and request recording 841.831 ms. These totals must not be added together as independent time or interpreted as PostgreSQL CPU consumption.

The plans use exact captured runtime templates and fixture parameters, including current eligibility rules. Their separate read-only executions may use custom plans different from warmed runtime generic plans. Writes and unregistered SQL retain fingerprints/timings only; expression text and bind values are redacted. The tag-plan evidence supports investigating the current-analysis join, but does not alone attribute the earlier concurrent failure to one query, CPU, GC, or any other single cause.

The prior [Linux capacity failure at 1bc35c3](../feed-linux-capacity-1bc35c3/README.md) still recorded 6,000 offered requests, 1,635 concurrency rejections (27.25%), and admitted-request p95 4,001.371 ms. The 100 sequential requests here do not replace that workload, validate the subsequent optimization, prove the 10 RPS/600-second gate, or establish monthly 99.9% availability. Cloudflare staging, real OAuth, production, deletion/recovery, and RPO/RTO acceptance are outside this diagnostic run.

## Separate PR255 required PostgreSQL evidence

[pr255-required-pg.log](pr255-required-pg.log) contains selected, unchanged original lines from [CI run 34263081942, storage job 102185626480](https://github.com/hikariming/ghfind/actions/runs/34263081942/job/102185626480). The PR head was `75a031849cedeae9a67170077ada7692487a7cf9`; Actions actually checked out test merge `28a729464c49d977f6f89bc7b220c1a07038a971`, merging that head into `45d6427a22943d23ce3acb413cff20dd9f4ef61b`. Both identities are retained explicitly.

With `FEED_REQUIRE_POSTGRES_TESTS=1`, `go test -count=1 -v ./internal/backend` ran and passed these real PostgreSQL regressions:

- `TestPostgresGovernanceInvalidatesTaxonomyLazily` — 0.23 seconds.
- `TestPostgresGovernanceTagCapacityAndCurrentAnalysis` — 0.23 seconds.
- `TestPostgresTagRecallCurrentAnalysisBeforeFanout` — 0.93 seconds.

The package and storage job succeeded. These are new independent CI execution records, not reconstructed stdout for the earlier local small-fixture test. Excerpt provenance includes full source-log SHA256 and exact original line numbers. This evidence supports the optimization's eligibility and boundary regression checks; it does not demonstrate optimized HTTP capacity.

## Offline verification

From this directory, `shasum -a 256 -c SHA256SUMS` verifies every preserved and derived file except the checksum list itself. The following uses only local files to verify original artifact bytes and the basic diagnostic completion conditions:

```sh
python3 - <<'PY'
import gzip, hashlib, json, pathlib
p = pathlib.Path('.')
m = json.loads((p / 'manifest.json').read_text())
raw = {}
for f in m['rawArtifacts']:
    stored = (p / f['path']).read_bytes()
    assert hashlib.sha256(stored).hexdigest() == f['storedSha256']
    data = gzip.decompress(stored) if f['encoding'] == 'gzip' else stored
    assert len(data) == f['sourceBytes']
    assert hashlib.sha256(data).hexdigest() == f['sourceSha256']
    raw[f['sourceName']] = data
r = json.loads(raw['diagnose.json'])
plans = json.loads(raw['actual-query-plans.json'])
assert r['baseline'] == plans['baseline'] == m['sourceSha']
assert len(r['observations']) == 100
assert all(x['status'] == 200 and x['items'] == 20 and not x.get('error')
           for x in r['observations'])
assert len(plans['plans']) == 16 and not plans['unobserved']
assert all(x['outcome'] == 'ok' for x in plans['plans'])
assert len({(x['template'], x['syntheticCohort']) for x in plans['plans']}) == 16
assert r['droppedTraces'] == 0 and r['durationSeconds'] <= 120
print('Original bytes and bounded diagnosis verified; capacity not evaluated.')
PY
```
