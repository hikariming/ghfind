# Ordinary Docker Feed API HTTP evidence

This package retains the original setup failure and corrected passing attempt.
The passing result demonstrates a bounded Feed business contract over HTTP to
the standard API image in local Docker with PostgreSQL. It is not full production
or end-to-end OAuth acceptance, and application deletion cleanup remained queued.

| Attempt | Exact source | Recorded result |
| --- | --- | --- |
| [Initial setup](setup-failure-565829a/README.md) | `565829abc21843bb20ad2a5f3b220d4124c2329f` | Temporary Unix initialization server passed readiness; marker connection failed during shutdown. No migrations, API container, or business HTTP execution. |
| [Corrected run](success-39def66/README.md) | `39def663ab662e66e0b3473dfc06285e761c2a26` | Authenticated PostgreSQL TCP readiness; migrations and real API container; 21 HTTP calls in 0.657723959 seconds passed the bounded contract. |

The successful attempt verified 34 tables' expected initial state, then used
50 direct synthetic projections and 50 submission-evidence rows. It checked
authentication failures, pagination, owner caps, event idempotency, deletion
fencing, and generation 4 deletion followed by generation 5 recreation. Its
`deletionCleanupStatus` remained `queued`. Synthetic signing and direct fixture
insertion do not represent GitHub OAuth or a completed assessment/source queue.

The failure and success directories preserve 7 and 11 original non-binary files,
respectively, without reformatting JSON, reordering logs, or changing reported
health and cleanup fields. The two timestamped PostgreSQL logs use deterministic
lossless gzip, preserving their original trailing whitespace; the other sixteen
original files are uncompressed. Four
original helper binaries across the two runs are intentionally omitted; their
original SHA-256 hashes were independently rechecked and recorded in each
manifest. No image archive or binary payload is committed.

## Supplemental cleanup observation

[cleanup-readback.json](cleanup-readback.json) is the original, separate read-only
observation at `2026-09-08T19:08:55.230760+00:00`, supplied after the runs. All nine
identities match the two reports' created resources plus their built image IDs:
three containers, two volumes, two networks, and two images. Every inspection
reported absence with an exit code of 1 and a matching not-found message. This
includes the images for which the original run recorded successful removal but
did not perform a subsequent inspection.

That observation supplements the run records; their cleanup fields are unchanged.
It does not inspect or claim cleanup of base images, build cache, host files, or
unrelated resources, and it is not an assertion about future resource state.
The preservation work only read the supplied artifacts and local Git objects;
it did not run another Docker command, load test, database test, or Cloudflare
operation.

## Offline verification

From this directory:

```sh
shasum -a 256 -c SHA256SUMS
python3 - <<'PY'
import gzip, hashlib, json
from pathlib import Path

root = Path('.')
package = json.loads((root / 'manifest.json').read_bytes())
reports = {}
for attempt in package['attempts']:
    directory = root / attempt['directory']
    manifest = json.loads((directory / 'manifest.json').read_bytes())
    run = json.loads((directory / 'run.json').read_bytes())
    assert run['sourceSha'] == manifest['sourceSha'] == attempt['sourceSha']
    assert run['cleanupSuccessful'] is True
    for entry in manifest['files']:
        if entry['retainedPath'] is None:
            assert run['binaries'][entry['originalPath']] == entry['sha256']
            continue  # Recorded binary hash only; binary bytes are omitted.
        data = (directory / entry['retainedPath']).read_bytes()
        if entry.get('encoding') == 'gzip':
            assert len(data) == entry['retainedBytes']
            assert hashlib.sha256(data).hexdigest() == entry['retainedSha256']
            data = gzip.decompress(data)
        assert len(data) == entry['bytes']
        assert hashlib.sha256(data).hexdigest() == entry['sha256']
    image = (directory / 'api-image-id.txt').read_text().strip()
    assert image == run['imageId'] == manifest['imageIdentity']['buildIid']
    assert image in (directory / 'build.log').read_text()
    if attempt['status'] == 'setup_failed':
        assert run['status'] == 'failed' and run['errorCode'] == 'command_failed'
        assert 'contractStatus' not in run and 'apiRuntime' not in run
    else:
        contract = json.loads((directory / 'contract.json').read_bytes())
        assert run['status'] == run['contractStatus'] == contract['status'] == 'passed'
        assert contract['sourceSha'] == contract['harnessBuildSha'] == run['sourceSha']
        assert run['apiRuntime']['imageId'] == image
        assert contract['httpCalls'] == len(contract['observations']) == 21
        assert contract['durationSeconds'] == 0.657723959
        assert contract['emptyBusinessTableCount'] == 34
        assert contract['facts']['projects'] == contract['facts']['submissionReceipts'] == 50
        assert contract['facts']['deletedGeneration'] == 4
        assert contract['facts']['recreatedGeneration'] == 5
        assert contract['facts']['deletionCleanupStatus'] == 'queued'
        assert 'storageWriterVersion' not in contract['healthz']
        assert 'storageWriterVersion' not in contract['readyz']
    reports[run['sourceSha']] = run
supplement = package['supplement']
data = (root / supplement['retainedPath']).read_bytes()
assert len(data) == supplement['bytes']
assert hashlib.sha256(data).hexdigest() == supplement['sha256']
readback = json.loads(data)
assert readback['observedAt'] == supplement['observedAt']
assert {a['sourceSha'] for a in readback['attempts']} == set(reports)
total = 0
for attempt in readback['attempts']:
    run = reports[attempt['sourceSha']]
    assert attempt['fixtureOwner'] == run['fixtureOwner']
    expected = {(r['kind'], r['id']) for r in run['created']} | {('image', run['imageId'])}
    actual = {(r['kind'], r['identity']) for r in attempt['resources']}
    assert actual == expected and len(actual) == len(attempt['resources'])
    for resource in attempt['resources']:
        assert resource['absent'] is True and resource['exitCode'] == 1
        assert resource['stdout'] == '[]\n'
        assert resource['identity'] in resource['stderr']
        assert any(s in resource['stderr'].lower() for s in ('no such', 'not found'))
    total += len(actual)
assert total == supplement['matchedOwnedResourceIdentities'] == 9
print('Both original attempts and nine supplemental cleanup identities verified.')
PY
```

Each attempt also has its own `SHA256SUMS`. The top-level checksum list covers
every package file except itself, including the two nested checksum lists.
`manifest.json` records the supplemental original path, byte count, and SHA-256;
the attempt manifests record source blob hashes and all original artifact hashes.
Offline verification checks preservation and consistency, not runtime behavior.

Neither attempt accepts completed deletion, S3 restore, source jobs, real OAuth,
Cloudflare Containers, capacity, monthly cost or availability, database transfer,
or production promotion. The passing run's health fields are retained exactly;
later source changes do not retroactively add a storage-writer field to this run.
