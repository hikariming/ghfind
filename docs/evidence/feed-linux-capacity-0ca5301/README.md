# Linux capacity evidence — 0ca5301 — passed

The isolated Linux run passed the finite capacity gate: **6,000/6,000 requests
succeeded**, with admitted-request p95 **57.326 ms**, p99 **60.488 ms**, maximum
**85.536 ms**, and no admission rejection or transport error. The report covers
600.081 seconds and 600 valid distinct seconds of internal resource observations.
The separate 250,000-event deletion/cancellation/archive recovery checks passed.
This is Linux synthetic-fixture evidence, not Cloudflare or production approval.

## Verified identity and preservation

| Item | Identity |
| --- | --- |
| Exact tested source | `hikariming/ghfind`, `0ca53012559a512d61a55a5eca373dca2f8f139c` |
| Required source CI | [34263794374](https://github.com/hikariming/ghfind/actions/runs/34263794374), successful `main` push at that exact SHA; finished before capacity dispatch |
| Capacity execution | [34264216366](https://github.com/hikariming/ghfind/actions/runs/34264216366), attempt 1, `workflow_dispatch`, conclusion `success` |
| Job | [102189413636](https://github.com/hikariming/ghfind/actions/runs/34264216366/job/102189413636), `ubuntu-24.04`, 2026-09-08 18:38:18–18:50:10 UTC |
| Artifact | ID `10071579469`, `feed-linux-capacity-0ca53012559a512d61a55a5eca373dca2f8f139c-1` |
| Original artifact ZIP | 243,526 bytes; SHA-256 `d2115cd2b5636ffcba10b63f891f0a192de41621796032ef257356c14e9dfe5c` |
| Harness binary | SHA-256 `85c49474fc8a207540759e2d9d951a758677ef4e9bf5fa3c5c966261f9669158`; Go 1.23.0 Linux/amd64 |

The downloaded ZIP's digest matches both GitHub artifact metadata and the actual
upload log. Its ten entries match the supplied original files byte for byte;
ZIP CRC validation also passed. The ZIP and executable are not duplicated here.
GitHub records artifact expiry at 2026-10-08 18:50:05 UTC; these repository copies
preserve the measurements beyond that window.

[manifest.json](manifest.json) records original and retained sizes/hashes, exact
source Git blob identities, compression settings and evidence boundaries.
[execution-evidence.json](execution-evidence.json) records selected read-only
GitHub run/job/artifact and preceding CI metadata.
[actions-source-cleanup.log](actions-source-cleanup.log) contains selected
**original byte lines**, preserving timestamps, escape sequences and endings.
Their original line numbers and whole-source-log hash are recorded in execution
metadata; omitted lines were not rewritten into a narrative. The excerpt shows
exact checkout, successful source/CI verification, 44 verifier tests passing,
fixed load progression, gate success, upload digest and actual fixture removal.
No credential-value lines are included.

## Measured outcome

The fixture is entirely synthetic: 50,000 projects, 5,000 users, 1,000,000 events,
50,000 submission-evidence receipts, 100,000 project tags, 5,000 requests and
50,000 served items at seed completion. No historical project was imported or
reclassified. Original counts are retained in [fixture.json](fixture.json).

| Measurement | Recorded value |
| --- | --- |
| Offered / admitted / successful | 6,000 / 6,000 / 6,000 |
| Schedule | Fixed 100 ms interval, 10 RPS; report duration 600.081426574 s |
| Admission rejections / transport errors | 0 / 0 |
| Offered-request failure rate | 0.0%; finite-run gate limit 0.1% |
| Admitted latency | p50 54.939 ms; p95 57.326 ms; p99 60.488 ms; max 85.536 ms |
| Unexpected successful page size | 0; fixed fixture expects 20 items |
| Maximum scheduling lateness | 1.243 ms; limit 1,000 ms |
| Internal resource coverage | 600 valid samples in 600 distinct seconds; no malformed/error samples |
| External PostgreSQL / MinIO | Each 2,400 valid samples across 601 distinct seconds; no unavailable markers |
| External host-vm | 601 samples in 601 distinct seconds, 600.146 s span |
| External malformed sample lines | 0 |

The original [gate.json](gate.json) has `passed: true`, `status: passed` and no
issues. Latency uses nearest-rank `durationMs` over all admitted HTTP attempts;
transport attempts would remain included. Admission rejections would count in
the offered-request denominator but not as zero-duration successful latency.
The exact-source verifier was imported and `verify()` called offline: its entire
returned dictionary equals the original gate. The original gate was not rewritten.

The fixture container limits are PostgreSQL 2 CPUs/2 GiB and MinIO 0.5 CPU/512 MiB.
[containers.txt](containers.txt) preserves inspected image-configuration digests
and limits; immutable image pull references are in the
[exact-source Compose file](https://github.com/hikariming/ghfind/blob/0ca53012559a512d61a55a5eca373dca2f8f139c/ops/feed-capacity-compose.yaml).
Those two kinds of image digest have different meanings. Runner CPU and memory
output is retained separately. This capacity artifact does not contain query
plans; none were reconstructed or copied from another run.

**Process-metric boundary:** the harness runs the load client/scheduler, Feed
`httptest` HTTP server and resource observer in one Go process. `CPUSeconds`,
`processCpuSeconds`, heap, goroutines and GC samples describe that combined
process. They are not an independent production Feed service CPU/memory reading.
The separate Docker/host observations provide resource context and coverage, not
CPU/GC/database causal attribution. This directory does not establish a cause
from those samples or extrapolate production cost.

## Deletion and recovery, separately recorded

[delete.json](delete.json) preserves the exact original document:

- The selected synthetic actor had 250,000 events before deletion and zero after;
  the fixture-wide remaining event count is 750,000.
- Cancellation observed the active cascade and rollback preserved its events.
- The accepted delete returned HTTP 202 in **1,393.394 ms** with status `queued`.
- Two actual HTTP 503 requests exercised the S3 fault-injection endpoint.
  The failure persisted as `queued`, phase `archive`, failures `1`, error
  `capacity_injected_s3_outage`.
- After reopening the cleanup adapter, the same deletion completed in three steps;
  the recreated user has profile version `2`.

These are bounded PostgreSQL/S3-compatible deletion recovery results. They do not
prove a real external provider outage, general backup restore, Cloudflare D1/R2
behavior or production RPO/RTO. The generic report also contains unrelated zero
fields such as `Completed`, latency/CPU fields and `loadStartedAt` at year 0001,
and null observation fields. They remain untouched. They are not deletion-load
measurements; the deletion-specific object contains the relevant evidence.
The raw `phase=delete completed=0 p95=0.0ms` log line is preserved on that basis,
not silently corrected or interpreted as a failed deletion.

After uploading evidence, the cleanup step succeeded and its original output
shows both containers, `ghfind-feed-capacity_capacity_data`, and the Compose
network removed. This is execution-log evidence, not a later independent runner
resource readback. Archiving this directory ran no load, database workload,
workflow dispatch, deployment or Cloudflare operation.

## Earlier failure remains preserved

The [1bc35c3 failure](../feed-linux-capacity-1bc35c3/README.md) is unchanged:

| Finite Linux run | Successful / offered | Admission rejected | Admitted p95 | Gate |
| --- | --- | --- | --- | --- |
| `1bc35c3`, run 34257139145 | 4,365 / 6,000 | 1,635 | 4,001.371 ms | Failed |
| `0ca5301`, run 34264216366 | 6,000 / 6,000 | 0 | 57.326 ms | Passed |

These separately identified runs use the fixed synthetic scale and show the
later run meeting its engineering thresholds. They are not a controlled
same-host experiment isolating one code change or CPU effect. The older
measurements, rejected requests and failed gate remain available; success here
does not rewrite or erase them.

## Byte verification and offline gate reproduction

The two long original files, `load.json` and `external-resources.jsonl`, are stored
with lossless gzip (level 9, empty filename, mtime 0). The other eight retain their
exact bytes, including `delete.json` and `gate.json`. README, manifest, execution
metadata and the selected log excerpt are supplemental, not original artifact
members. [SHA256SUMS](SHA256SUMS) covers every retained file except itself.

Run from the repository root; this checks retained/uncompressed hashes, rebuilds
only temporary input files and imports the verifier from the tested SHA. It does
not invoke the writing CLI or start a database, HTTP load or infrastructure:

```sh
python3 - <<'PY'
from pathlib import Path
import gzip, hashlib, importlib.util, json, subprocess, sys, tempfile

base = Path('docs/evidence/feed-linux-capacity-0ca5301')
sha = '0ca53012559a512d61a55a5eca373dca2f8f139c'
for line in (base / 'SHA256SUMS').read_text().splitlines():
    expected, name = line.split('  ', 1)
    assert hashlib.sha256((base / name).read_bytes()).hexdigest() == expected
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
    original_bytes = (target / 'gate.json').read_bytes()
    verifier = target / 'verify.py'
    verifier.write_bytes(subprocess.check_output([
        'git', 'show', sha + ':scripts/verify-feed-capacity.py']))
    spec = importlib.util.spec_from_file_location('capacity_recheck', verifier)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    result = module.verify(target, sha)
    assert result == json.loads(original_bytes) and result['passed']
    assert (target / 'gate.json').read_bytes() == original_bytes
    print('Original bytes verified; exact-source finite gate reproduced: passed.')
PY
```

A successful ten-minute synthetic run does not establish monthly 99.9%
availability, Cloudflare capacity, real GitHub OAuth, authenticated production
E2E, production cost, migration readiness or permission to switch live traffic.
Those independent gates remain outside this evidence.
