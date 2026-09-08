# Writer-2 ordinary Docker runtime verification

The completed bounded verification passed for exact source
`a3c3f841c15a247d5a2b187aa0f6ac5fa5e1616e`. API and worker used the **same ordinary
Linux/amd64 image** with different entrypoints, a new real PostgreSQL/pgvector
database and a new real MinIO bucket. No application code was changed.

This verifies independent startup, dependency readiness, authentication rejection
and idle process lifecycle. It is not a complete Feed E2E, GitHub OAuth,
assessment/queue execution, capacity, recovery-under-active-work or Cloudflare
deployment result. The earlier capacity reliability failure remains unresolved.

## Build identity

| Field | Value |
| --- | --- |
| Exact clean source/build VERSION | `a3c3f841c15a247d5a2b187aa0f6ac5fa5e1616e` |
| Dockerfile / target / platform | `Dockerfile.feed` / `api` / `linux/amd64` |
| Local tag retained | `ghfind-feed-portability:a3c3f84` |
| Local immutable image/index ID | `sha256:8a16df3fa40d303f6c07de0d2f2fd25efaa9c3c1c3e4ec62ed68078e2c55411f` |
| Platform manifest in BuildKit output | `sha256:954988b5cfe3f732ce90e3aa382d91c5838698bba719efd70960b49acf4bad1a` |
| Image configuration digest | `sha256:f0a9123eb802f509f0237f3cb74289baff35d2985df584ef19151b8f576db65f` |
| Actual binary compiler/target | Go 1.23.12, CGO disabled, Linux amd64 |
| API binary SHA-256 | `e3d401b8e2f703774cacef1dc17612fbda8180e1c1f07099698cafcfa2724a20` |
| Worker binary SHA-256 | `78b8ba9f23b396526597c99b0879e5c743a0321167edf36c307cf8ddfc53f37d` |

The image was built once, locally, from the pinned Dockerfile base, and never
pushed. Docker's local `RepoDigests` record is preserved but is not proof of a
registry upload, Cloudflare availability or production deployment. Both running
containers' `Image` fields match the immutable ID above. Binary files were copied
from those containers only to inspect their Go build metadata and hashes; the
large ELF copies are not committed. The complete build output is in `build.log`.

## Completed checks

Final fixture setup through cleanup ran at
**2026-09-08T17:27:45.582240Z–17:27:53.985128Z**. There were 18 recorded HTTP responses
(including two MinIO health responses), no load loop and no submitted business
jobs. Readiness connection polling was capped at 20 attempts per endpoint;
connection errors during these polls are not separately retained as responses.
All Feed health, readiness and authentication responses carried `no-store`.

- Fresh PostgreSQL installed migrations 1–22, reader contract 1 and storage writer
  contract 2. Initial and final project/user/job counts were zero; final deletion
  count was zero. No historical or production data was imported.
- API and enabled worker each returned health/readiness 200 with the exact source
  SHA, `storeProfile:"postgres"` and `writerEpoch:1`. The actual transport field
  is **`contractVersion:"1"` (a string)**. Readiness does not expose a separate
  `storageWriterVersion` field; this observability limitation was not patched or
  filled in by the report.
- Changing only this disposable database's compatibility range to writer 1 made
  both running processes return readiness 503. Restoring writer 2 made both
  return 200. The same image and processes remained in place for this check.
  The writer-1 pre-privacy application is not a compatible rollback for schema 22.
- Anonymous `/api/feed/projects?limit=20` returned 401 `authentication_required`.
  Cleanup without its independent bearer credential also returned 401. Authorized
  cleanup read the real empty PostgreSQL task state and returned
  `{"status":"idle","steps":0,"processed":0}`. No queue acknowledgment or
  completed business task was fabricated.
- Stopping MinIO made the worker return readiness 503 while API readiness stayed
  200. Restarting MinIO intentionally discarded its empty tmpfs bucket; after
  recreating that dedicated unversioned bucket, worker readiness returned 200.
  This demonstrates dependency checking, not archive persistence or recovery.
- Both process containers ran as UID/GID 65532, with all capabilities dropped,
  `no-new-privileges`, a read-only root and a 16MiB `noexec,nosuid,nodev` tmpfs.
  A read-only-mounted diagnostic executable verified UID/GID, a root write
  rejected with `EROFS`, and a successful tmpfs write/read. It is a test helper,
  not part of either business binary or the immutable image.
- Sending SIGTERM to each idle API/worker process produced the application's
  `draining Feed server` log and exit code 0 without OOM. Docker stop commands
  completed in 0.049s and 0.046s respectively; these are idle lifecycle samples,
  not an in-flight-work drain or cold-start SLO. Restarting the same containers
  restored readiness 200; each pre-stop tmpfs marker was absent and writable
  temporary storage worked again.

The worker's AssessmentSource dependency was an explicitly separate **health-only
synthetic fixture**. It answered only the authenticated source health operation,
rejected assessment paths, and did not supply assessment facts or jobs. Therefore
worker readiness here proves the configured dependency checks can run in ordinary
Docker, not that a real assessment source or queue has been accepted end to end.

## Resource and network scope

The private namespace used only new names prefixed `ghfind-portability-a3-` and
an exclusive `feed_portability_test` database. PostgreSQL's private container
network namespace was shared with MinIO, source fixture, API and worker so their
HTTP dependencies could use loopback. Only test host ports 55445, 59005, 58085
and 58086 were published to 127.0.0.1. The working network was a dedicated ordinary
bridge, not the pre-existing application network. Plain HTTP was limited to
loopback; this local topology is not a production networking recommendation.

| Resource | Limits |
| --- | --- |
| PostgreSQL/pgvector | 1 CPU, 1GiB RAM, 128MiB shared memory, 40 connections |
| MinIO | 0.5 CPU, 256MiB RAM, 16MiB disposable data tmpfs |
| API and worker, each | 0.5 CPU, 256MiB RAM/swap cap, 64 PIDs, 4,096 file descriptors |
| Source health fixture | 0.1 CPU, 64MiB RAM, 16 PIDs |

Container commands, immutable database/storage image references, actual runtime
limits and security options are retained in the original run record. The API
and worker are amd64 images running under Docker Desktop on a macOS arm64 host;
this is not a dedicated native-amd64 performance environment. The helper's
host compiler differs from the container business binary compiler and is
identified separately in `environment.json`.

## Preliminary failures retained

The first resource initialization used Docker `--internal`. This environment did
not make the published PostgreSQL port reachable from the host migration client,
which returned connection refused; no API or worker checks ran. The fixture was
cleaned and the dedicated bridge configuration corrected. See `setup-failure/`.

The next attempt reached API readiness 200 but the test script incorrectly
asserted numeric contract version 1 instead of the actual string `"1"`. It
stopped and cleaned up. An unsuccessful edit to the local test script then
caused that same incorrect assertion to run once more and stop at the same point;
the script was subsequently checked before execution. Both incomplete attempts
are retained in `assertion-failure/` and `assertion-failure-2/`. These are test
setup/assertion failures, not application readiness failures. The coordinator
explicitly allowed correcting these errors and completing the missing bounded
checks with the same image. No earlier full successful verification or capacity
run was repeated, and the final result does not hide these attempts.

## Evidence, reproduction and cleanup

`run-original.json.gz` retains every executed command, exit status, duration,
response, dependency/control result and cleanup assertion from the completed
run. It decompresses to the exact original JSON; `run-summary.json` excludes only
the verbose command list. Original logs, helper sources and orchestration scripts
are preserved. All credentials shown are explicit local synthetic fixture
credentials. `manifest.json` and `SHA256SUMS` identify and verify the artifacts.

To reproduce, check out the exact source into an isolated clean worktree, review
the retained `run.py` resource names/ports and adjust only its local `ROOT`/`OUT`
paths. Build the image with the recorded `docker build --platform linux/amd64
--file Dockerfile.feed --target api --build-arg VERSION=<exact SHA>` command and
`--iidfile`. Restore `probe.go.txt` and `bucket.go.txt` as `probe.go` and `bucket.go`
in that temporary output directory; the archive suffix keeps standalone helper
programs outside Go package discovery. Compile the probe there with
`GOOS=linux GOARCH=amd64 CGO_ENABLED=0`. The script refuses collisions with its named containers,
network, volume or host ports, applies migrations only to the new test database,
and cleans only resources it successfully created. Reproduction is another
explicit verification run, not part of this evidence.

Final cleanup was verified at **2026-09-08T17:27:53.985103Z**: all five created
containers, the dedicated PostgreSQL volume and network were absent. Root's
55440/59001 resources and existing API containers remained present. The local
image tag/ID above was retained for reinspection. No remote resources, production
data, traffic, business source files or phase-5 scripts changed.
