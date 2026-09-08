# Linux capacity evidence — 1bc35c3 — failed

The isolated Linux run **failed the capacity gate**: 1,635 of 6,000 offered
requests were rejected by the concurrency limit (27.25%), and admitted-request
p95 was 4,001.371 ms. Both exceed the approved limits of 0.1% and 800 ms.
The successful deletion/recovery exercise and complete resource observations do
not change this result. This directory preserves the failure for diagnosis;
it is not release approval.

## Source, run and artifact identity

| Item | Verified identity |
| --- | --- |
| Repository and exact source | `hikariming/ghfind`, `1bc35c368a5b73a353d3b07234be653ce7cc3ac4` |
| Required source CI | [CI run 34256682390](https://github.com/hikariming/ghfind/actions/runs/34256682390), exact SHA, successful push run on `main` |
| Capacity execution | [Run 34257139145](https://github.com/hikariming/ghfind/actions/runs/34257139145), attempt 1, `workflow_dispatch`, conclusion `failure` |
| Job | [102165686949](https://github.com/hikariming/ghfind/actions/runs/34257139145/job/102165686949), `ubuntu-24.04`, 2026-09-08 17:26:51–17:39:10 UTC |
| Artifact | ID `10068804555`, `feed-linux-capacity-1bc35c368a5b73a353d3b07234be653ce7cc3ac4-1` |
| GitHub artifact ZIP | 268,136 bytes; SHA-256 `ab362634156b4524707b598fe6f607211d0b02322c5015c5f7cee43b68e5296d` |
| Built harness | Go 1.23.0, Linux/amd64; binary SHA-256 `e766a26a3d8ecfeff22db5c623bd916bf5105c6ed7b6d405673d85be0b38bd87` |

GitHub's reported ZIP digest was checked against a freshly downloaded ZIP;
all 11 supplied original files matched its entries byte for byte. That ZIP and
the executable are not duplicated here. The uploaded artifact was set to expire
on 2026-10-08; the repository copies preserve the evidence after that retention
window. [execution-evidence.json](execution-evidence.json) records selected
read-only GitHub metadata and bounded log excerpts, including 44 verifier tests
passing, the real gate exiting 1, the artifact digest, and fixture removal.

[manifest.json](manifest.json) records the source SHA, selected source-file Git
blob IDs/content hashes, original and retained file digests, and verification
boundaries. It covers the exact harness/observer/verifier/fixture sources used
by the run. The complete repository SHA remains the identity for transitive
application code and dependencies. The source verification step succeeded
before building and executing the harness.

## Preserved measurements

The initial fixture contains 50,000 projects, 5,000 users, 1,000,000 events and
50,000 submission-evidence receipts. It is entirely synthetic; no historical
project admission or production data was imported or reclassified.

| Measurement | Observed | Gate result |
| --- | --- | --- |
| Offered requests | 6,000 on the fixed 100 ms schedule; 601.392 seconds report duration | Complete |
| Successful responses | 4,365; all have 20 items in this fixed fixture | Recorded |
| Concurrency-limit rejections | 1,635; counted in the offered-request denominator | Failure rate **27.25%**, above 0.1% |
| Transport errors | 0 | Recorded; no omitted transport attempts |
| Admitted latency | 4,365 samples; p50 2,613.409 ms, **p95 4,001.371 ms**, p99 4,483.060 ms | p95 above 800 ms |
| Largest scheduling lateness | 9.997 ms | Within 1,000 ms |
| Internal Go/PostgreSQL observations | 601 valid distinct seconds; zero malformed or observer-error samples | Coverage passes |
| External PostgreSQL observations | 601 distinct seconds over 599.500 seconds | Coverage passes |
| External MinIO observations | 601 distinct seconds over 599.500 seconds | Coverage passes |
| Host vmstat observations | 602 distinct seconds over 601.223 seconds | Coverage passes |
| External missing/malformed samples | Zero Docker unavailable markers; zero malformed lines | Recorded |

The raw [gate.json](gate.json) has `status: failed` and exactly two threshold
issues: `load.failureRate` and `load.admittedP95Ms`. Admission rejections have
zero HTTP duration and are excluded from latency percentiles, while remaining
failures in the 6,000-offered denominator. Offline execution of the verifier at
the exact source SHA reproduces the entire original gate JSON. The load step's
successful process exit means it produced its report; the later dedicated gate
correctly failed the job.

The recorded container constraints are PostgreSQL 2 CPUs/2 GiB and MinIO
0.5 CPU/512 MiB. [containers.txt](containers.txt) retains actual inspected image
configuration digests and limits; the immutable image pull references
are in the exact-source
[Compose fixture](https://github.com/hikariming/ghfind/blob/1bc35c368a5b73a353d3b07234be653ce7cc3ac4/ops/feed-capacity-compose.yaml).
The two types of image digest have different meanings and are not substituted
for one another. Runner CPU and memory output is preserved separately.

**Query-plan limitation:** [query-plans.json](query-plans.json) is retained
unchanged, but its SQL comes from the simplified
[diagnostic plan generator](https://github.com/hikariming/ghfind/blob/1bc35c368a5b73a353d3b07234be653ce7cc3ac4/cmd/feed-capacity/plans.go).
It omits current runtime conditions such as revoked submission evidence,
negative preferences and active canonical-tag joins, and does not cover the
complete project hydration, session validation or request-write paths. It is
not the full SQL workload executed by the Feed request. Its small individual
EXPLAIN times cannot establish that real request queries are fast or identify
the cause of this failure. Resource samples support bounded observations, not
CPU/GC/database causal attribution. No bottleneck cause is established here.

## Independent deletion and recovery outcome

[delete.json](delete.json) records a high-volume synthetic user's 250,000 events
before deletion and zero for that user afterwards; the fixture-wide remaining
event count is 750,000. The cancellation probe observed the active database
cascade and preserved the original events through rollback. The accepted
request returned HTTP 202 in 1,427.169 ms.

The archive failure probe observed two real HTTP 503 S3 requests and recorded
`capacity_injected_s3_outage`. An independent database read confirmed the
persisted cleanup failure: `queued`, phase `archive`, one failure with that
error code. After reopening the storage adapter, cleanup completed for the
same deletion ID in three steps. The recreated profile version is 2.
These fields pass this fixture's bounded deletion/recovery checks. They do not
validate general backup restore, production RPO/RTO, real OAuth, or Cloudflare
D1/R2 behavior.

The cleanup step succeeded after evidence upload. Its logs explicitly show
both fixture containers, `ghfind-feed-capacity_capacity_data`, and the Compose
network removed. This is execution-log evidence; no later independent Docker
state readback is claimed. Archiving this directory performed no deployments,
resource mutations or repeated load test.

## File preservation and offline reproduction

`load.json` and `external-resources.jsonl` are losslessly stored as `.gz`, with
empty gzip filename headers and zero mtime. The other nine original files,
including the failed gate, retain their exact bytes. The new README, manifest
and execution metadata are labeled supplementary material. [SHA256SUMS](SHA256SUMS)
covers every retained file except itself; the manifest also records hashes of
the uncompressed original bytes.

From the repository root, this read-only replay writes only a new temporary
directory, uses the verifier source at the tested SHA and expects exit **1**.
It does not start databases, issue requests, or rerun capacity work:

```sh
python3 - <<'PY'
from pathlib import Path
import gzip, hashlib, json, subprocess, sys, tempfile

base = Path('docs/evidence/feed-linux-capacity-1bc35c3')
sha = '1bc35c368a5b73a353d3b07234be653ce7cc3ac4'
for line in (base / 'SHA256SUMS').read_text().splitlines():
    digest, name = line.split('  ', 1)
    assert hashlib.sha256((base / name).read_bytes()).hexdigest() == digest
manifest = json.loads((base / 'manifest.json').read_text())
with tempfile.TemporaryDirectory(prefix='ghfind-capacity-recheck-') as temporary:
    target = Path(temporary)
    for item in manifest['files']:
        raw = (base / item['retainedName']).read_bytes()
        if item['encoding'] == 'gzip':
            raw = gzip.decompress(raw)
        assert len(raw) == item['originalBytes']
        assert hashlib.sha256(raw).hexdigest() == item['originalSha256']
        (target / item['originalName']).write_bytes(raw)
    original = json.loads((target / 'gate.json').read_text())
    verifier = target / 'verify-feed-capacity.py'
    verifier.write_bytes(subprocess.check_output([
        'git', 'show', sha + ':scripts/verify-feed-capacity.py']))
    result = subprocess.run([sys.executable, str(verifier), '--directory',
                             str(target), '--release-sha', sha], check=False)
    assert result.returncode == 1
    assert json.loads((target / 'gate.json').read_text()) == original
    print('Preserved bytes verified; exact-source gate reproduced: failed.')
PY
```

This is a finite Linux PostgreSQL/pgvector plus S3-compatible synthetic-fixture
result. It does not establish Cloudflare capacity, authenticated production
E2E, monthly 99.9% availability, or eligibility for a platform fallback.
Performance acceptance remains open and requires a separately identified run
after justified changes, preserving this failed result intact.
