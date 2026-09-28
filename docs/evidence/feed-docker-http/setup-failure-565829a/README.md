# Ordinary Docker HTTP harness: setup failure at 565829a

This attempt **failed before migrations, API container creation, or any business
HTTP contract execution**. It is retained alongside later attempts so a successful
rerun cannot replace the original failure evidence.

The exact source was `565829abc21843bb20ad2a5f3b220d4124c2329f`. The run started
at `2026-09-08T19:02:35.868223+00:00` and finished at
`2026-09-08T19:03:31.504885+00:00`, using the local `desktop-linux` Docker context
and explicitly requesting `linux/amd64`. This was a local fixture attempt, not a
GitHub Actions run or production deployment. The initial source and clean-checkout
commands are recorded in [run.json](run.json); their output was not separately
retained. The exact harness implementation requires both checks to pass before
building or creating resources. [manifest.json](manifest.json) records the tested
harness, Python/Go contract-test sources, and Dockerfile Git blob identities and
SHA-256 hashes.

## Observed failure

The retained command sequence and PostgreSQL log establish this order:

1. The API image and two host-side helper binaries built successfully.
2. The fixture created its owned network, volume, and PostgreSQL container.
3. Three `pg_isready` calls returned exit code 2. The fourth returned 0; all used
   the default Unix socket because no `-h` argument was supplied.
4. PostgreSQL's temporary initialization server announced its Unix socket and
   readiness. Its log subsequently records that the fixture database did not yet
   exist, followed by `CREATE DATABASE` and the initialization server's shutdown.
5. The marker `psql` command returned exit code 2. Its complete output in
   [fixture-marker.log](fixture-marker.log) reports a Unix-socket connection
   failure because the database system was shutting down. The PostgreSQL log
   records the fast shutdown request at `19:03:30.657 UTC` and the corresponding
   connection failure at `19:03:30.671 UTC`.
6. The harness recorded `errorCode: command_failed`, collected the owned
   PostgreSQL log, and entered its cleanup path.

The readiness check accepted the temporary initialization server and therefore
did not establish readiness for the subsequent marker connection. The complete
original PostgreSQL log is retained losslessly in
[ghfind-http-94531839-pg.log.gz](ghfind-http-94531839-pg.log.gz).
It concatenates the subprocess's stdout and stderr, as the tested harness did;
its original order and bytes are preserved, including the final earlier-timestamp
initialization warnings. No log lines have been reordered.

`migration-build.log` and `harness-build.log` are genuinely empty successful-build
logs. Building `feed-migrate` does not mean migrations ran. There is no migration
execution command, API container create/start command, or contract test execution
command in the recorded sequence. There is no `migration.log`, `contract.log`,
`contract.json`, `apiRuntime`, or `contractStatus` in this attempt. The configured
50-project / 100-request / 120-second limits in `run.json` are intended limits,
not completed workload counts. The built API image was never started.

## Resource cleanup boundary

The fixture owner was `94531839-f78a-4a58-9707-8b63b40991d1`. The harness checked
both its owner and exact source labels before deleting resources. All operations
below belong to that attempt; no global prune or unrelated resource cleanup was
performed by its recorded commands.

| Resource | Recorded result | Verification retained in `run.json` |
| --- | --- | --- |
| `ghfind-http-94531839-pg` | `removed` | Delete by owned container ID returned 0; subsequent name inspection returned 1. |
| `ghfind-http-94531839-pgdata` | `removed` | Owned volume deletion returned 0; subsequent inspection returned 1. |
| `ghfind-http-94531839` | `removed` | Delete by owned network ID returned 0; subsequent name inspection returned 1. |
| Built API image | `removed_or_absent` | Ownership inspection returned 0 and `docker image rm --no-prune` returned 0. No post-removal image inspection was recorded. |
| Planned API container | Never created | Initial collision inspection returned 1; there is no subsequent create attempt. |

The harness reports `cleanupSuccessful: true`. For containers, volume, and network,
its source only records `removed` after interpreting the post-removal inspection
as a recognized not-found response; raw inspection responses are not retained.
The image's removal success is a command result, without an independent absence
probe. The API image's base images and Docker build cache were outside this
cleanup scope; `--no-prune` does not claim to remove them. The locally downloaded
PostgreSQL image and the two host-side binaries were also retained outside the
owned runtime-resource cleanup. Preservation performed no new Docker inspection
or mutation, and makes no claim about later resource state.

The separate [cleanup readback](../cleanup-readback.json), supplied after both
attempts finished, records all four of this attempt's owned resource identities
as absent at `2026-09-08T19:08:55.230760+00:00`, including the built image. This
later evidence supplements the original run; it does not change its cleanup
fields or expand cleanup to base images, build cache, or host binaries.

## Preserved bytes and identities

All seven non-binary files from `/tmp/ghfind-docker-http-565829a` are included
unchanged or losslessly encoded. The timestamped PostgreSQL log uses deterministic
gzip to preserve its original trailing spaces on empty lines; decompression
restores the exact original bytes. The other six files are uncompressed. `SHA256SUMS`
covers every retained file except itself; `manifest.json` separately records the
original nine-file inventory, byte lengths, and hashes. The two large binaries
are deliberately omitted from Git. Their original bytes were read in bounded
chunks and their hashes matched the original `run.json` values:

| Built artifact | Original bytes | SHA-256 |
| --- | ---: | --- |
| `contract.test` | 30,420,546 | `411fb995c0f41c5293d8036a0595cfac147c653937749d0e8d5c6443b705e1ef` |
| `feed-migrate` | 13,475,810 | `1bb66c4b44f0b7c4a5c6d743c555e9f5cdc87b022ba27d55ec6046bd8aebad99` |

The build IID was
`sha256:c094e779aba5fc71e7c4987b79ec1cba773baba01807ad29f5b8685809664ed4`.
It matches `api-image-id.txt`, `run.json`, and the exported manifest-list digest
in [build.log](build.log). This establishes agreement between the retained build
records, not a registry publication or a retained image archive. The pinned
PostgreSQL reference was
`pgvector/pgvector@sha256:137f044b0efe3d57f39b972b9b53641b1f2045b99d879e298bbf514a25787dcf`.

The public synthetic PostgreSQL password in the unchanged command report comes
from the tested harness's fixture constant. It is not a production credential.
The artifact directory itself was not modified or executed during preservation.

## Offline verification

From this directory, verify retained bytes without invoking Docker or a database:

```sh
shasum -a 256 -c SHA256SUMS
python3 - <<'PY'
import gzip, hashlib, json
from pathlib import Path

root = Path('.')
manifest = json.loads((root / 'manifest.json').read_bytes())
run = json.loads((root / 'run.json').read_bytes())
assert run['sourceSha'] == manifest['sourceSha']
assert run['status'] == 'failed' and run['cleanupSuccessful'] is True
assert 'contractStatus' not in run and 'apiRuntime' not in run
for entry in manifest['files']:
    if entry['retainedPath'] is None:
        assert run['binaries'][entry['originalPath']] == entry['sha256']
        continue  # Binary hash record only: the binary is not retained here.
    data = (root / entry['retainedPath']).read_bytes()
    if entry.get('encoding') == 'gzip':
        assert len(data) == entry['retainedBytes']
        assert hashlib.sha256(data).hexdigest() == entry['retainedSha256']
        data = gzip.decompress(data)
    assert len(data) == entry['bytes']
    assert hashlib.sha256(data).hexdigest() == entry['sha256']
image = (root / 'api-image-id.txt').read_text().strip()
assert image == run['imageId'] == manifest['imageIdentity']['buildIid']
assert image in (root / 'build.log').read_text()
assert not manifest['result']['businessHttpExecuted']
print('Retained original bytes and setup-failure identities verified.')
PY
```

This verifies the evidence package. It does not reproduce the failure or prove
business portability, OAuth, source outbox/queue execution, S3 deletion, capacity,
Cloudflare behavior, production readiness, or cleanup beyond the recorded attempt.
Those acceptance gates remain separate, even if a later corrected attempt passes.
