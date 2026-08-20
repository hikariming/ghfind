# Project Feed backend runbook

This runbook turns the architecture plan into an operator-safe deployment. It
separates launch-blocking safety checks from metrics that should accumulate
after launch; no step requires waiting a fixed number of calendar days. The
code default remains `FEED_MODE=off`; the current Railway production services
are deliberately configured as `baseline`, with Gorse contribution disabled.

## Shipped components

- `/ghfind-feed-migrate`: forward-only embedded SQL runner with an advisory
  lock. It verifies pgvector before creating the migration ledger and never
  installs extensions. It also owns idempotent, concurrent Feed retrieval
  indexes: the bounded tag-affinity index at any catalog size, and a
  dimension-specific HNSW index once an active embedding corpus reaches 50k.
- `/ghfind-feed-bootstrap`: explicitly acknowledged, operator-triggered,
  one-shot installer for `vector` and `btree_gin`. It is never deployed by the
  automatic main-branch gate.
- Go API: `/api/feed/tags`, `/preferences`, `/projects`, project state,
  `/events`, and `/profile`, plus secret-protected reconcile/tag-review routes.
- Go worker: confirmed `feed.catalog-sync.v1` events after Turso commits, a
  30-second leased/keyset **incremental** repair path (five-minute overlap),
  six-hour full anti-entropy reconciliation, embedding/profile rebuild,
  transactional-outbox relay, retention cleanup, and optional Gorse shadow
  projection. Reconciliation batches repository metadata and source-hash
  comparisons; it does not issue one Turso graph query per project.
- PostgreSQL: authoritative Feed behavior/profile/taxonomy state and a
  rebuildable Turso project projection.
- `/ghfind-feed-backup`: PostgreSQL 17 logical backup/verify/restore binary,
  built in a separate pinned image and scheduled independently from API/worker.
- Private S3-compatible Bucket: encrypted `feed` archives and completion
  manifests. Gorse data is intentionally excluded because it is rebuildable.
- Upstash: only 30-minute candidate sessions and per-user rate limits.
- RabbitMQ: durable projection transport. An outage delays projections but
  does not roll back committed events.

The 30-second loop is deliberately not a full Turso table scan. It reads only
assessment rows changed since its durable `(updated_at, repo_key)` cursor and
replays a bounded overlap through source-hash idempotency. A full keyset scan
runs on first boot, after a source-count decrease, and at most once per six
hours. This keeps normal Feed load proportional to changes while retaining an
anti-entropy repair path for missed messages and unsupported out-of-band source
deletions.

## Railway topology and one-time database action

Create a private `ghfind-feed-postgres` service from the exact image in
`docker-compose.backend.yml`, attach a persistent volume at
`/var/lib/postgresql/data`, and do not add a public domain. Staging must use a
distinct database and volume. Railway Pro volume backup/PITR is not a launch
dependency; the next section defines the Hobby-compatible recovery path.

The Railway operator—not API/worker startup—must connect with the privileged
database role and run exactly once:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;
```

`vector` is required by Feed migrations. Locked Gorse `v0.5.11` also checks
`btree_gin` and attempts to create it when absent; pre-installing it here lets
the runtime role stay unprivileged. Treat both statements as controlled
database bootstrap, never as API/worker/Gorse startup permissions.

The current production project has a private, undeployed
`ghfind-feed-bootstrap` service (`c59d4dc5-93bc-4b32-a32d-05f1028ec99d`)
preconfigured with the private DSN and a deliberate acknowledgement guard. A
human operator must run the following from the repository root before the
first main-branch Feed deployment:

```bash
RAILWAY_CALLER=user:feed-extension-bootstrap \
  railway up --ci --yes \
  --project 815ec3e1-679a-41b4-a7c0-6ba65b64db8e \
  --environment b9d929d6-a1e4-4e74-b43f-38ed529cc6f1 \
  --service c59d4dc5-93bc-4b32-a32d-05f1028ec99d \
  --message "operator-approved Feed PostgreSQL extension bootstrap"
```

Success is the single log message `Feed PostgreSQL extensions installed` and
a zero exit status. Afterwards verify `pg_extension`, remove the temporary
bootstrap service, and run `ghfind-feed-migrate`. Do not add the bootstrap
service to `.github/workflows/deploy-production.yml`.

Create a separate login for Gorse and grant it only `CONNECT` plus
`USAGE, CREATE` on `public`; do not grant it `USAGE` on `feed` or privileges on
any `feed.*` table. Use a generated production secret, not the local Compose
credential. Gorse's `table_prefix`, `cache_table_prefix`, and
`data_table_prefix` remain mandatory defense-in-depth; its DSNs use this role,
while `FEED_DATABASE_URL` uses the application/migration role. Verify the
boundary before shadow rollout:

```sql
SET ROLE <gorse_role>;
SELECT 1 FROM feed.projects; -- must fail with permission denied
RESET ROLE;
```

Then deploy the normal backend image as a one-shot service/job with
`GHFIND_ROLE=feed-migrate` and `FEED_DATABASE_URL` set to the private database.
The job must exit zero before API/worker rollout. Re-running it is safe. API and
worker roles only verify the schema and extension; they never run DDL.

In the current Railway project this service is `ghfind-feed-migrate`. The
main-branch deployment gate runs it before API and worker on every green CI
revision, so a merge cannot start Feed code against an older schema. Migration
failure prevents both long-lived deployments; forward-only schema changes are
not rolled back with application images.

The same migration job is the only allowed owner of adaptive vector-index DDL.
It uses `CREATE INDEX CONCURRENTLY`: API and worker processes never create or
rebuild indexes. At every green main deployment it first ensures the
tag-affinity index, then, when there are at least 50,000 active embeddings,
creates the matching `vector(N)` HNSW index for `N ≤ 2000` or `halfvec(N)` for
`2001..4000`. The Feed query automatically uses that dimension-specific
expression and otherwise retains exact cosine. If the catalog crosses 50k
without a code deployment, manually redeploy only `ghfind-feed-migrate` from
the current approved main revision; it is idempotent and does not restart the
API or worker.

Use these service variables on API and worker unless noted:

```text
FEED_MODE=off
FEED_DATABASE_URL=postgres://...private.../ghfind_feed?sslmode=disable
FEED_SIGNING_SECRET=<independent random value, at least 32 characters>
FEED_INTERNAL_GITHUB_IDS=<comma-separated internal GitHub numeric IDs>
FEED_CANARY_BPS=0
FEED_GORSE_LIVE_BPS=0
FEED_SHADOW_OUTCOME_WINDOW=24h
```

Embedding variables belong on the worker only. Configure all or none:

```text
FEED_EMBEDDING_BASE_URL=https://provider.example/v1
FEED_EMBEDDING_API_KEY=...
FEED_EMBEDDING_MODEL=...
FEED_EMBEDDING_DIMENSIONS=1536
```

The current Railway project already contains the private pgvector/PostgreSQL
service with a 5 GB persistent volume, the forward-only migration service, and
the temporary bootstrap service above. API and worker have the same private DSN
and independent signing secret; `FEED_CANARY_BPS=0` and
`FEED_GORSE_LIVE_BPS=0`. `FEED_INTERNAL_GITHUB_IDS=109743670` keeps the
pre-frontend rollout limited to the current operator account. No public
database domain exists. Gorse is not on the Baseline launch path and has not
been provisioned.

### 2026-08-13 production preflight snapshot

- Existing Railway API and worker `/healthz` plus `/readyz`: all four returned
  `200`; the prior 24-hour Railway error/warn query returned no entries for API,
  worker, or Feed PostgreSQL.
- Feed PostgreSQL: pinned pgvector image digest, one active 5 GB volume in
  `READY`, one running replica, and no public domain. API/worker/migrate/
  bootstrap DSNs and API/worker signing secrets are present without exposing
  values.
- Runtime rollout: API and worker are `baseline`, restricted to the internal
  allowlist with `FEED_CANARY_BPS=0`; Gorse live BPS is zero. No embedding
  provider is configured, so launch is intentionally tag/quality/latest only
  and incurs no embedding-provider cost.
- Automation: the upstream repository has the four required Actions secret
  names. API, worker, Postgres, RabbitMQ, and the backup image have healthy
  deployment anchors. The deployment gate's rollback state machine and Vercel
  bypass-header isolation have local failure-injection coverage.
- **One-time blocker:** bootstrap and migrate still have no deployment. Until
  the human-approved bootstrap command above succeeds, neither extension nor
  the `feed` schema is considered present. This is fail-safe: the automatic
  migration job stops the release before API/worker rollout.
- The backup cron image has built successfully, but a successful scheduled
  archive after real Feed schema/data exists is still required operational
  evidence; its absence does not justify claiming a completed restore SLA.
- The production Vercel project must have Protection Bypass for Automation
  configured. The gate requires its system environment variable and rolls back
  if the protected-domain smoke cannot run.

## Hobby-compatible backup and recovery

The production project now uses this path instead of Railway Pro native volume
Backups/PITR:

- Bucket `ghfind-feed-backups`
  (`c3b93c96-dcbb-466c-8acd-3c460353b249`), private, `sjc`.
- Cron service `ghfind-feed-backup`
  (`e5fa86a0-4789-441d-aaa2-8d45fcd6e90f`), no domain, schedule
  `17 */6 * * *` UTC, restart policy `NEVER`.
- Custom config `/railway.feed-backup.json` and pinned
  `Dockerfile.feed-backup`; a green main gate builds this service after the
  migration, API, and worker deployments.
- 35-day object retention (`840h`) and a 30-minute per-run timeout.

Each successful run executes the following contract:

1. `pg_dump --format=custom --compress=zstd:9 --schema=feed` using PostgreSQL
   17 client tools. Credentials are passed through `PG*` environment variables,
   never command arguments.
2. Require `feed.projects` and `feed.schema_migrations` in the archive listing.
3. Encrypt the dump as authenticated, bounded-memory AES-256-GCM chunks and
   compute plaintext and ciphertext SHA-256 values.
4. Upload the encrypted archive, verify remote size and hash metadata, download
   it again, check both hashes, decrypt it, and parse it with
   `pg_restore --list`.
5. Write `.manifest.json` last. Its presence is the completion marker. Only
   after that does the run remove objects older than 35 days.

This yields an approximately six-hour RPO and a manual restore RTO; it is not
point-in-time recovery inside that interval. A future Pro upgrade may add PITR
as defense in depth, but no Feed code or launch gate depends on it.

`FEED_BACKUP_ENCRYPTION_KEY` is an independent base64-encoded 32-byte key.
Losing this key makes every archive unrecoverable; putting a copy in the same
Bucket does not count as escrow. The current production key has been
hash-verified into this operator Mac's login Keychain as account
`ghfind-feed-backup`, service `com.ghfind.feed-backup.encryption`; copy it into
the team's durable recovery vault when one exists. Do not paste its value into
tickets, logs, or the repository.

The 2026-08-13 drill used a real PostgreSQL 17/pgvector source, encrypted object
upload, object download/verification, and a distinct scratch database. Source
and restored databases both contained migration versions `1..10` and 24
`feed` tables. A separate compatibility drill completed against the actual
Railway Bucket; its `_compat-test` objects were removed afterwards.

Migrations `11..14` add reconciliation lease/candidate-path indexes, the
bounded cold-start graph-refresh cache, and immutable analysis identity for
tag proposals; they do not change the 24-table restore inventory. The current
CI bootstraps a disposable PostgreSQL 17/pgvector service, applies all `1..14`
migrations plus migration-owned adaptive index maintenance, and runs the
real store integration suite on every revision.

### Verify and restore procedure

`verify` selects the newest completion manifest unless
`FEED_BACKUP_MANIFEST_KEY` identifies an exact recovery point. It downloads,
hashes, decrypts and parses the archive without opening PostgreSQL:

```text
ghfind-feed-backup verify
```

For a restore, provision a distinct private pgvector/PostgreSQL scratch service,
activate `vector` there as a controlled operator action, and configure a
one-shot instance of the pinned backup image with Bucket credentials plus:

```text
FEED_DATABASE_URL=<source identity, used only by the safety guard>
FEED_RESTORE_TARGET_DATABASE_URL=<distinct scratch/private target>
FEED_RESTORE_ACK=I_UNDERSTAND_THIS_OVERWRITES_THE_TARGET
FEED_BACKUP_MANIFEST_KEY=<optional exact manifest>
```

Run `ghfind-feed-backup verify` first and then `ghfind-feed-backup restore`.
The binary refuses the source host/port/database as a target. `pg_restore`
uses `--clean --if-exists --single-transaction --exit-on-error`; therefore the
target is destructive by design. Compare at least migration range/table count
and representative event/project counts before promoting the restored service.
Never test restore against production.

Operationally, a cron execution is healthy only when it exits zero with
`Feed PostgreSQL logical backup completed`. Alert if there is no successful
execution for seven hours. Railway skips overlapping cron runs; the 30-minute
timeout leaves a large safety margin before the next six-hour slot.

## Baseline rollout

### Same-day launch path

There is no Gorse dependency and no shadow wait on the critical path:

1. Provision PostgreSQL, install the two extensions, run all migrations, start
   the worker in `baseline`, and pass reconciliation/hard-filter checks.
2. Start the API in `baseline` with an internal allowlist and exercise the API,
   deletion, Upstash, RabbitMQ, and Feed-Postgres failure drills.
3. After the short fixture load test passes, either set the desired
   `FEED_CANARY_BPS`, or deliberately clear the allowlist and leave BPS at zero
   to make Baseline available to all OAuth users. Gorse may remain undeployed.
4. Add Gorse asynchronously. Even when Gorse is never enabled, tag, embedding,
   quality, freshness, MMR, and exploration all remain live in the Go Baseline.

This path can be completed in one deployment session. The first reconciliation
is a full keyset pass; subsequent confirmation cycles are 30-second incremental
repairs, not a multi-day observation requirement. Multiple worker replicas
cannot duplicate either operation because PostgreSQL owns a 45-second renewable
lease.

1. Keep API/worker on `off`; run migrations and inspect all fourteen migration
   rows in `feed.schema_migrations`.
2. Set only the worker to `baseline`. Confirm the initial full reconciliation,
   compare Turso assessments with `feed.projects`, then require three
   consecutive clean incremental cycles. Review `feed.tag_proposals`; proposed
   tags must have zero joins into active `feed.project_tags`.
3. If an embedding provider is configured, confirm descriptor hashes prevent
   duplicate calls. Provider failures use exponential retry (30 seconds up to
   six hours) and move the unchanged descriptor to
   `feed.projection_failures.dead_lettered_at` after eight failures. A changed
   descriptor resets the failure budget. Stop the provider and prove new
   projects still project and tag-only Feed candidates remain available.
   A changed `FEED_EMBEDDING_MODEL` builds inactive project/tag vectors first;
   `feed.embedding_model_state.active_model` must remain on the old model until
   every current descriptor exists. Activation is one transaction and only
   then bumps user profile versions and queues project/user reprojection.
4. Put API on `baseline` with only `FEED_INTERNAL_GITHUB_IDS`; do not set a
   public BPS yet. Exercise every API via the same-origin Vercel rewrite.
5. Load-test 10k and 50k project fixtures at 50 concurrent users. Record SQL
   plans and require warm page p95 ≤400 ms/p99 ≤900 ms and event p95 ≤200 ms.
6. Verify data quality and deletion, then expand `FEED_CANARY_BPS` using sticky
   HMAC buckets. A zero BPS plus an allowlist means internal-only; an empty
   allowlist and zero BPS means all users only for deliberate baseline rollout.

Emergency stop is `FEED_MODE=off` followed by API/worker redeploy. Do not drop,
truncate, reverse migrations, or roll back data to disable Feed.

Project removal and adoption-risk overrides must go through the machine-secret
protected `/api/internal/feed/projects/moderate` endpoint with `operator` and
`reason`. Actions are `remove`, `restore`, or `risk_override` (the latter also
requires `enabled`). The database rejects an override unless every blocker is
an allowed `high_risk:*` category; `critical` risks and insufficient source
verification can never be overridden. Every effective action increments the
project projection version, writes `feed.project_moderation_actions`, and
queues a Gorse visibility update. A new assessment/source hash always clears a
prior risk override, forcing the new evidence to receive its own review.

The supported visibility SLA is explicit: a Feed moderation removal is
immediate; an assessment/risk update is observed by the event path or the
30-second incremental cursor repair; cached cursor pages rehydrate
publishability and `notInterested` state on every page. Direct physical deletion
of a Turso assessment outside the application contract has no row-level change
journal, so its final repair is the six-hour anti-entropy pass. Do not use
out-of-band physical deletion as a moderation workflow.

## Gorse shadow only

The locked image is:

```text
zhenghaoz/gorse-in-one:0.5.11@sha256:b249a44b6affabde48a88c0438ebfd810edbb91f872f8dc080286f460a4f0ee7
```

Create private `ghfind-gorse`, with no public API/dashboard/database port.
Mount the reviewed production equivalent of `ops/gorse/config.toml`, replace
all local credentials, set `GORSE_BASE_URL`, `GORSE_SERVER_API_KEY`, and
`GORSE_ADMIN_API_KEY`, then use `baseline_gorse_shadow`. `auto_insert_user` and
`auto_insert_item` must remain false. Gorse tables use isolated prefixes/role
and are disposable.

The worker projects item/user/feedback messages and asynchronously stores Top
100, latency, invalid-item count, and baseline overlap in
`feed.gorse_shadow_results`. Shadow failures never execute on the Feed request
path. Hidden/non-publishable returned IDs count as invalid and are never fed to
the user. The maintenance worker waits for `FEED_SHADOW_OUTCOME_WINDOW` (24h by
default, 1h minimum), then records held-out positives, `Recall@50`, and the exact
window used. Requests without a positive outcome keep recall null rather than
being misreported as zero. Recall is a continuing diagnostic and never blocks
Baseline launch.

Baseline workers drain projection messages without calling Gorse, preventing a
durable queue from growing indefinitely while the optional engine is disabled.
Before the first shadow run—or after intentionally replacing the disposable
Gorse database—queue a complete fact replay with the machine-secret protected
endpoint:

```sh
curl -fsS -X POST "$API_URL/api/internal/feed/gorse/rebuild" \
  -H "Authorization: Bearer $GITHUB_ROAST_CLI_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"operator":"on-call-login","reason":"initial shadow projection"}'
```

The response reports independent project/user/event counts and a unique
`rebuildId`. Projects and users are enqueued before feedback; rerunning the
operation uses new dedupe keys and is safe. `unsave` and
`undo_not_interested` delete the corresponding Gorse feedback row rather than
leaving a zero-valued training record.

Profile deletion first persists a minimal tombstone outside the cascading user
tables. Baseline mode may acknowledge the live projection without Gorse, but a
later full rebuild always enqueues outstanding deletions before current users
and feedback. The Gorse worker removes the tombstone only after the remote
delete succeeds, so a cohort rollback cannot resurrect a deleted profile.

Baseline launch does not wait for Gorse. To admit Gorse candidates, first pass
the locked-image contract, full-rebuild count reconciliation, zero hidden/risk/
not-interested leak checks, projection-lag target, and 100 consecutive private
recommendation requests with success ≥99% and p95 <200ms. Fixed fixtures may
complete this operational sample when early traffic is sparse; they are not
evidence of product lift. Catalog/feedback volumes and Recall become gates only
for collaborative/FM learning, not tag/embedding retrieval. Gorse never
replaces Go hard filters or final ranking.

After those safety gates pass, set `FEED_MODE=gorse_canary` but keep
`FEED_GORSE_LIVE_BPS=0` for the first deploy. Exercise at least 20 internal
sessions, then use 5% → 25% → 100% cohorts with at least 100/250/500 live Feed
requests per level instead of waiting 7 or 14 days. At genuinely tiny traffic,
an operator may accept the absence of a product-quality conclusion and move
directly from the internal allowlist to 100%; the safety gates and kill switch
are not waivable. Online Gorse calls have a 200ms deadline; returned IDs are mapped
back through PostgreSQL, hidden/blocked/not-interested projects are removed,
and Gorse-exclusive candidates are capped at 60 of 240 before the Go mixer.
Failure records `gorse_unavailable` and returns the baseline. The emergency
kill is `FEED_GORSE_LIVE_BPS=0`, independent from the overall Feed cohort.

## Failure drills

- Stop Gorse: baseline pages and latency stay unchanged; shadow errors grow.
- Reject embedding calls: old vectors remain active and new projects are
  tag-only.
- Stop RabbitMQ: `/events` still commits PostgreSQL event and outbox rows; after
  recovery relay delivers them once by event UUID.
- Break Upstash: a new read page succeeds with `nextCursor: null` and
  `cursor_store_unavailable`; existing cursors expire explicitly. Feed's
  per-user read limiter deliberately fails open in this one degradation mode so
  it cannot contradict the first-page availability contract. State/event/delete
  writes fail closed with `503 rate_limit_unavailable`; metrics record the read
  degradation.
- Break Turso after a successful reconciliation: Feed serves the last projected
  catalog.
- Break Feed PostgreSQL: API and worker processes still start, their existing
  `/readyz` endpoints remain governed only by the original core dependencies,
  and Feed-specific `/feed-readyz` returns `503`. Feed APIs return
  `503 feed_unavailable`; `/api/projects`, scoring, boards, OAuth, analysis, and
  the three pre-existing worker consumer lanes must remain healthy. The
  production gate requires both `/feed-readyz` probes before promoting a new
  release, without coupling runtime health or rollback health to Feed.

Retention is enforced by the worker: raw events 180 days, request/served
snapshots 90 days, delivered outbox rows seven days. Persistent save/block state
remains until undo or profile deletion. Event payloads reject arbitrary client
metadata and do not store IP or User-Agent.

## Verification commands

```sh
go test ./...
pnpm typecheck
pnpm lint
pnpm vitest run src/lib/__tests__/backend-route-ownership.test.ts
docker compose -f docker-compose.backend.yml --profile feed config
docker build -f Dockerfile.feed-backup -t ghfind-feed-backup:verify .
```

For the real PostgreSQL integration contract, point only at a disposable
pgvector database:

```sh
FEED_TEST_DATABASE_URL='postgres://.../disposable?sslmode=require' \
  go test ./internal/backend -run TestPostgresFeedStoreIntegration -count=1 -v
```

The 10k/50k release load qualification is deliberately opt-in and destructive.
Its database name must contain `loadtest`; it truncates only `feed.projects` and
`feed.users` (with cascades), seeds 16-dimensional vectors and historical
impressions, then measures 200 candidate requests and 200 50-event batches at
50 concurrent callers through the real 24-connection application pool:

```sh
FEED_LOAD_TEST_DATABASE_URL='postgres://.../ghfind_feed_loadtest?sslmode=require' \
FEED_LOAD_TEST_ACK='I_UNDERSTAND_THIS_TRUNCATES_FEED_SCHEMA' \
FEED_LOAD_TEST_PROJECTS=50000 \
  go test ./internal/backend -run TestPostgresFeedStoreLoad -count=1 -timeout=25m -v
```

The test fails above candidate p95 400ms/p99 900ms, event-batch p95 200ms, or
on any request error. Never point it at production, staging, or a recovery
target; create a disposable database whose name contains `loadtest`.
It invokes the same migration-owned index-maintenance operation after seeding,
so the 50k run also verifies the HNSW threshold transition rather than merely
testing an already-created local index.
