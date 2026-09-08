# Ordinary Docker Feed API HTTP contract

This opt-in harness closes the business-HTTP gap in the earlier [startup/idle Docker evidence](../evidence/feed-portability-a3c3f84/README.md). It currently provides **code, pure unit checks and compilation preparation only**. No Docker fixture or actual business run has been executed for this harness at initial delivery. An execution report must be produced and reviewed before calling these checks accepted.

The test runs the ordinary `Dockerfile.feed` API image, using its default `/usr/local/bin/feed-api` entrypoint, against a new local PostgreSQL database. There is no Next, Cloudflare runtime, in-process fallback API, or special production business code. The harness uses synthetic signed gateway contexts; these are not GitHub OAuth. Its 50 projects are direct synthetic store projections with fixture submission receipts, not real submitted assessments or queue/executor evidence.

## Scope and limits

The public business assertions are reused from `runPortableAPIContract` in `internal/backend/feed_crossprofile_test.go`. The original dual-profile wrapper still runs the same business assertions plus its existing session-identity contract. The Docker entry sends the business assertions through an injected real HTTP client; it does not run the separate in-process session-identity sub-contract or claim to prove its races through Docker.

The Docker business contract checks:

- Real `/healthz` and dependency-aware `/readyz`, exact build SHA, HTTP contract `1`, PostgreSQL profile and writer epoch `1`. It validates storage writer version `2` when the field exists; absence on the original baseline is recorded rather than invented.
- Anonymous and forged-identity rejection, `no-store`, and absence of private ranking/session fields in public pages.
- Pagination with an intervening impression, no repeated repositories, and at most two projects from one owner in each rolling 20-item window.
- Cross-user impression token/cursor rejection, state changes, and an actual repeated event response with `accepted=0`, `duplicate=1`.
- Deletion returning queued status, cross-user status isolation, old cursor/token invalidation, a new full page and a recreated profile generation above the persisted deletion floor.
- Matching owned database facts, including 50 projects/receipts and zero old outbound rows after the existing PostgreSQL user cascade.

The shared deadline is 120 seconds, including ownership readback, all fixture checks, the 50-project direct seed and HTTP body reads. There are at most 100 HTTP calls, sequentially, each with a five-second timeout and two-MiB response bound. Redirects are not followed. Health calls are counted; Docker listener startup uses TCP connection probes rather than extra HTTP. Build, migration and container preparation occur before this contract window, each with separate finite command timeouts. The subprocess receives a 125-second Go test timeout and a 130-second parent limit to retain an incomplete report when the ordinary context path does not settle.

The API alone does not execute the queued cleanup task. A queued deletion is not a completed deletion. No worker, source adapter, S3/MinIO, object restoration, real OAuth/assessment, migration promotion, capacity/SLO or production acceptance is included. The earlier startup/idle worker evidence remains separate.

## Fixture ownership

`scripts/run-feed-docker-http.py` defaults to a no-action plan. `--execute` requires a clean exact-SHA checkout and a fresh absolute output directory outside it. It only accepts a local Docker daemon through a Unix socket. It refuses existing resource names and occupied `127.0.0.1:55446`/`127.0.0.1:58087` ports before resource creation.

Every new network, volume, container and built API image carries a random UUID ownership label and the exact source SHA. PostgreSQL is pinned to `pgvector/pgvector@sha256:137f044b0efe3d57f39b972b9b53641b1f2045b99d879e298bbf514a25787dcf`, limited to one CPU/one GiB. The API uses the immutable built image ID, half a CPU/256 MiB, UID/GID 65532, a read-only root, dropped capabilities and bounded tmpfs/PIDs. It shares only this new PostgreSQL container's network namespace. No production credentials enter either container.

The orchestrator creates the fixed `public.feed_portability_fixture` marker only in its new database before migrations, containing owner UUID, source SHA, fixture version and API host port. The Go entry independently requires explicit loopback `*_test` DSN, exact source SHA, matching compiled harness SHA, output path, image ID and both container IDs. Before database writes or business HTTP, read-only Docker inspection verifies those IDs, owner/SHA labels, running state, API entrypoint/image, network namespace, exact host-port bindings, and that the API's internal DSN points to this marker's PostgreSQL instance and database. Inspected environment values are never emitted.

The database marker must be unclaimed. Every actual Feed base table must be empty except the exact migration-seeded taxonomy/control rows; aliases, proposals/authorship, audit tombstones, archives and any future business tables are included in the empty check. The current fixture expects migration set 22 and fails closed on seed-count drift. Only after these checks can a conditional marker update claim the fixture. No harness path uses `DROP`, schema reset, or a missing-marker fallback. An existing fixture cannot be rerun; create a new owned fixture.

## Preparation and the later bounded run

Pure checks do not require Docker or PostgreSQL:

```sh
python3 scripts/test-feed-docker-http.py
go test ./internal/backend -run '^TestPortability' -count=1
go test -tags feedportability ./internal/backend -run '^TestPortability' -count=1
```

The build-tagged real entry is `TestFeedDockerHTTPPortability`. Missing configuration fails; it never skips. The commands above select only pure helpers, not that integration entry.

After the implementation is committed and reviewed, use its actual complete 40-hex SHA from a clean checkout. First inspect the plan:

```sh
python3 scripts/run-feed-docker-http.py \
  --release-sha <exact-40-hex-commit> \
  --directory /tmp/ghfind-docker-http-<unique-run>
```

Only the separately scheduled actual run adds `--execute`. It builds the same source into the standard API image, compiles the tagged test binary with `portabilityBuildSHA` set by the linker, creates the new fixture, applies the existing migration binary, and runs exactly the named integration test. The Python wrapper supplies `FEED_PORTABILITY_DATABASE_URL`, `FEED_PORTABILITY_API_ENDPOINT`, `FEED_PORTABILITY_SOURCE_SHA`, `FEED_PORTABILITY_OWNER`, `FEED_PORTABILITY_REPORT`, `FEED_PORTABILITY_API_CONTAINER`, `FEED_PORTABILITY_PG_CONTAINER` and `FEED_PORTABILITY_IMAGE_ID`; the dedicated DSN requires `sslmode=disable&connect_timeout=3`. Manual invocation must supply all of those identities and satisfy the same ownership checks.

## Reports and cleanup

The orchestrator writes `run.json` before setup and preserves bounded command/build/test logs and binary/image hashes. The Go entry creates `contract.json` with mode 0600 before contacting dependencies and refuses overwriting it. It records method, URL path without token-bearing query strings, status, duration, fixed error codes, health identities and synthetic aggregate facts. It records no signed token, raw event body, arbitrary SQL, or inspected container environment.

The finalizer handles normal completion, exceptions, SIGINT and SIGTERM. It reads logs only from resources with matching ownership labels, then removes only names for which creation was attempted and ownership is positively reverified. It removes containers by immutable ID before the owned volume/network, and the owned API image by its recorded image ID. A partial create or client timeout is reconciled by ownership readback. An inspection/daemon failure is not treated as proof of absence; cleanup failure makes the run fail. There is no wildcard prune and no removal of unrelated services or caches.

Machine/daemon loss or an uncatchable process kill can prevent a finalizer from running. Such an incomplete report is not cleanup proof: use the recorded UUID and exact resource identities for read-only inspection and reviewed recovery, never a global Docker cleanup command. The evidence should retain actual container removal/absence results, the original reports, tested source/image identities and the HTTP assertion result before documenting an accepted Docker business run.
