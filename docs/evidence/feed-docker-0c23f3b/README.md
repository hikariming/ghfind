# Ordinary Docker API lifecycle evidence

Observed 2026-09-08. Binary build version `0c23f3b` resolves to integration commit
`0c23f3b` (recorded in this repository); the OCI image index is pinned in
`observations.json`. This is a local amd64 Docker Desktop image, not a published
Cloudflare registry digest or a Cloudflare Container run. It predates the later
executor archive-readiness and ranking performance changes.

The same `Dockerfile.feed` image contains separate API and executor binaries.
This run exercises the API entrypoint only against a fresh, local PostgreSQL 17
pgvector database `ghfind_docker_portability_test`, migrated through 0019. It runs
as 65532:65532, with a read-only root filesystem, no-new-privileges, 256 MiB memory,
one CPU and a 1 MiB /tmp tmpfs. No Next or Cloudflare runtime is running in the API
container. No production endpoint, data or credential is used.

Observed: health/readiness 200 with the expected build and contract; anonymous
`/api/feed/projects` 401; all responses no-store; SIGTERM drained and exited 0 in
197.523 ms; readiness returned after restart; a marker actually written from a
process **inside the container tmpfs** was absent after restart. Twelve subsequent
readiness requests at at most six concurrent calls succeeded. Readiness latency
is not Feed request latency or capacity evidence.

The small temporary Go marker helper is bind-mounted read-only at /opt/probe for
the drill; it is not added to the application image. `docker cp` was rejected on
a read-only rootfs and did not reliably address the mounted tmpfs on a writable
rootfs, so those initial harness attempts are not disk-loss evidence. The accepted
run uses `docker exec` with the helper. An earlier readiness check against the
shared disposable contract database returned 503 because its final fault test
intentionally renamed migration 0015. A fresh separate database was created;
no production migration ledger was changed to make the probe pass.

Reproduction: build Dockerfile.feed with VERSION=0c23f3b and tag
`ghfind-feed-local-contract:compatible`; create the named local PostgreSQL database
on port 55440 and run `cmd/ghfind-feed-migrate` against it. Build
`ephemeral-probe.go` with GOOS=linux GOARCH=amd64 CGO_ENABLED=0 into
`/tmp/ghfind-ephemeral-probe/bin`. `reproduce.py` is the exact local harness; it uses
only explicit disposable names and refuses an existing container rather than
silently replacing it. Its local dummy credentials have no remote authority.
It preserves the created container for inspection. Inspect before removing it.

Not proven: CF cold start p95, production OAuth, assessment execution, task
recovery, database promotion/restore, application rollback or the 800 ms Feed SLO.
