# Ordinary Docker HTTP contract passed at 39def66

The bounded business HTTP contract passed on exact source
`39def663ab662e66e0b3473dfc06285e761c2a26`, after the initial
[setup failure](../setup-failure-565829a/README.md). The correction replaced the
Unix-socket `pg_isready` probe with an authenticated TCP `psql SELECT 1` against
the requested database, with connection and statement deadlines. The tested
source is a descendant of `0ca53012559a512d61a55a5eca373dca2f8f139c`; evidence
describes that implementation, not fields added to later main commits.

The entire local run lasted from `2026-09-08T19:06:54.306692+00:00` to
`2026-09-08T19:07:36.503720+00:00`. The business contract itself ran from
`2026-09-08T19:07:34.966082Z` to `2026-09-08T19:07:35.623813Z`, reporting
**21 HTTP calls in 0.657723959 seconds**. These are distinct timing scopes and
neither is a capacity or availability measurement.

## What the retained evidence establishes

[run.json](run.json) records a successful marker, execution of the built
migration helper, API container creation and start, the external-HTTP contract,
and owned resource cleanup. [migration.log](migration.log) records migration
completion. [contract.log](contract.log) records the single successful
`TestFeedDockerHTTPPortability` test, and [contract.json](contract.json) preserves
its original checks, individual HTTP observations, response fields, and facts.

The API ran with the standard `/usr/local/bin/feed-api` entrypoint from the
locally built image. The retained runtime identity has user `65532:65532`, a
read-only root filesystem, a 0.5-CPU limit, and a 268,435,456-byte memory limit.
Both container creation commands explicitly requested `linux/amd64`, on local
Docker Desktop's `desktop-linux` context. This does not establish native host
execution or performance on a separate Linux server.

The test verified fixture ownership and the endpoint's association with the
owned PostgreSQL/API containers before making business writes. It inspected
34 Feed tables before seeding. The original field is named
`emptyBusinessTableCount`, but these were **expected initial-state checks**:
seven seed/control tables had fixed nonzero counts (including 22 migration
records and 13 tag definitions), while the other tables had to be empty. It does
not mean all 34 tables contained zero rows. The test then inserted 50 direct,
synthetic project projections with 50 corresponding submission-evidence rows.
These are not real assessments or proof of source-outbox delivery.

The 21 HTTP observations cover actual build/readiness responses, anonymous and
forged identity rejection, stable pagination around an impression, owner caps,
cross-user token/cursor rejection, event retry idempotency, deletion status
isolation, old-generation rejection, and a full new-generation page. Expected
401/400/404/410 responses are successful negative cases, not transport failures.
The duplicate event result was `accepted: 0, duplicate: 1`.

The deletion endpoint returned 202. Its persisted deletion floor was 4, the
recreated user's generation was 5, and the tested outbound event row was absent
after deletion. **Deletion cleanup remained `queued`.** No cleanup executor or
archive sink was run; this attempt does not prove completed deletion or S3
recovery. Runtime-resource cleanup is a different operation and cannot complete
the application's deletion job.

The original health response reports contract `1` and the exact source version.
Readiness reports `storeProfile: postgres`, `writerEpoch: 1`, and `ready: true`.
Neither response contains `storageWriterVersion`. That field has not been added
to the raw report or inferred from a newer implementation.

## Build identities and cleanup

The built API image ID was
`sha256:78d3ef65c62b5a2cc1131d0e64b0da365603d0bb39c93dd84437616528156e0a`.
It matches `api-image-id.txt`, the exported manifest-list digest in
[build.log](build.log), and both `imageId` and `apiRuntime.imageId` in `run.json`.
The image itself is not archived here or claimed to have been pushed to a
registry. PostgreSQL used the same pinned pgvector image reference as the
initial attempt, recorded in `run.json` and `manifest.json`.

The original binary hashes were independently recomputed by reading the files
in bounded chunks, and matched `run.json`. The binaries are omitted from Git:

| Built artifact | Original bytes | SHA-256 |
| --- | ---: | --- |
| `contract.test` | 30,420,546 | `3c80b841886759486b89ae120bcdc8907748ba2205997d9ca48aa58cd265e0fb` |
| `feed-migrate` | 13,475,810 | `1bb66c4b44f0b7c4a5c6d743c555e9f5cdc87b022ba27d55ec6046bd8aebad99` |

Fixture owner `f44e6d82-dba2-44fd-927e-e28a65fddab5` identifies the two containers,
network, volume, and built image. The original run reports
`cleanupSuccessful: true`. Each container, volume, and network removal has a
subsequent inspection and a `removed` result; the image records a successful
`rm --no-prune` command and `removed_or_absent`, with no post-removal image probe
inside the run itself. The separate [cleanup readback](../cleanup-readback.json)
records all five exact owned identities as absent at
`2026-09-08T19:08:55.230760+00:00`, retaining stdout, stderr, and exit codes. Base
images, build cache, and host-side helper binaries are outside that resource
cleanup scope.

All eleven non-binary original files can be recovered byte-for-byte, including
three empty logs. The timestamped PostgreSQL log uses deterministic lossless
gzip to preserve its trailing spaces; the other ten files are uncompressed.
`manifest.json` records all thirteen original files and selected
exact-source Git blob identities; `SHA256SUMS` checks every retained file except
itself. The public synthetic signing values and PostgreSQL password in the
unchanged commands come from the tested harness constants. They are not live
OAuth identities or production credentials.

Use the [package verification instructions](../README.md#offline-verification)
to check these retained bytes and identities. This preservation step ran no
Docker, database, or Cloudflare commands. This finite local result does not
complete OAuth, real assessment, source queues, worker execution, S3 recovery,
Cloudflare, capacity, monthly cost, migration, or production acceptance.
