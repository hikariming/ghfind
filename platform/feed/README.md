# Feed binding adapter

This private Worker implements Go Feed capability contract v1 over D1/R2 bindings.
It is not connected to the existing production Worker. Its configuration contains
only placeholder resource IDs. Formal deployment must use reviewed GitHub Actions
and an isolated resource manifest; do not replace placeholders with production IDs
for local tests.

`POST /internal/feed/v1/{operation}` requires a dedicated `FEED_BRIDGE_SECRET`
Bearer credential and `X-Feed-Contract: 1`. Public OAuth authentication stays in the
gateway/API. The adapter validates identities against stored request ownership and
checks the writer epoch and expected profile version inside every mutation batch.
No endpoint accepts SQL or executes DDL.

Implemented capabilities: health, taxonomy list/propose, users ensure/get, preferences
replace, candidate recall, availability, complete request attribution, state changes,
typed events, private sessions, deletion fencing/status, leased source-event jobs
and ordered projection application. `FeedArchive` provides
versioned actor/generation-scoped R2 operations to bounded executor jobs. Source
assessment access is a separately authenticated capability. Queue transport,
deletion cleanup scheduling remain integration work. Operator-only status/replay
and durable cleanup capabilities are described below.

All request bodies are bounded while reading the stream: 128 KiB normally, 2 MiB
for private `sessions.put` and `requests.save`. Item limits remain 240 per session
and 50 per served page. This does not change the public gateway's 128 KiB limit.
Times are UTC RFC3339 on the wire and integer Unix milliseconds in D1. Project
assessment confidence is 0–100; tag confidence and strengths are 0–1.

Migrations `migrations-feed/0003_feed_runtime_contract.sql` and
`0004_feed_executor_protocol.sql` are additive and safe to reapply. They do not
approve proposals or infer submission evidence. Candidate
eligibility requires matching assessment provenance; historical rows remain
quarantined until verified evidence is imported by a reviewed projection job.
Existing canonical taxonomy v1 and existing tables are preserved.

The profile version also acts as a generation fence. Deletion writes a durable
floor, removes current preference/state/session visibility and queues cleanup in
the same transaction. It returns **pending** until an executor has completed
primary, archive and semantic cleanup. Cleanup must use the captured profile floor
and generation-specific archive prefix; it must never delete a subsequently
created profile. Accepting the deletion alone never claims that cleanup has run.

## Reproduce local verification

```sh
cd platform/feed
pnpm install --frozen-lockfile
pnpm types
pnpm typecheck
pnpm test
pnpm build
```

The contract suite runs in the actual workerd runtime with local D1 and R2
bindings using Cloudflare's Vitest integration, not a libsql mock. It verifies
atomic rollback under concurrent profile updates, exact request/event retries,
actor scoping, 240-key queries without exceeding parameter limits, submission
filtering, private snapshot attribution, behavior effects, deletion fencing and
generation-scoped archive cleanup. `pnpm build` is a dry run only.

Executor tests additionally cover concurrent lease claims, restart/lease expiry,
lost acknowledgements, eight-attempt dead letter, bounded retry delays, immutable
event identity, receipt substitution, duplicate/out-of-order projection, governance
and proposal-command retries. Jobs use a 90-second lease for the executor's
60-second task deadline. Application results commit before `jobs.complete`.

Source projection stores the verified core receipt kind exactly (`app_submission`,
`agent_submission`, `verified_backfill`) in `feed_project_source_versions`; an
Agent submission is never relabelled as owner evidence. Unknown tags remain
proposals. User proposals use `feed_user_tag_proposals` so their source cannot be
confused with the older assessment proposal table. An operator must include both
tables in a future bounded governance review workflow.

This is local execution evidence, not remote Cloudflare staging, performance,
cost, migration round-trip or production OAuth E2E evidence. Those are separate
release gates. The adapter never reports asynchronous deletion completed merely
because its transaction committed.

Upstream APIs used: [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Durable cleanup and operator recovery (schema 5)

Apply additive migration `0005_feed_cleanup_checkpoints.sql` before deploying this
adapter. `POST /internal/feed/cleanup/v1/{pending,claim,step,release,fail}` uses the
**executor** secret; the ordinary API bridge credential is rejected. `pending {}`
uses indexed due-work checks so a cron can leave the Go container asleep when idle.
`claim` takes `{writerEpoch,leaseOwner,leaseSeconds:90}`. `step` and `release` take
`{writerEpoch,deletionId,leaseOwner}`; `fail` also requires a bounded `errorCode`.
A step handles at most 100 rows/objects and persists its checkpoint. Normal release
preserves progress without consuming failures. Eight failures exhaust a task;
expired leases count as failures, with at most 100 expired tasks recovered per claim.

`completed` means current profile visibility was fenced, old-generation primary
records were removed/redacted, archive bodies were erased, and the semantic sink
was confirmed disabled or cleaned. This version supports the explicit disabled
semantic state. Setting the persisted policy to required makes cleanup fail closed
until a real semantic cleanup adapter is delivered. Recreating a profile uses a
version above its deletion floor, and cleanup preserves that newer generation.

Archive writes must use `FeedArchive.put`: it registers the key in a D1 transaction
with writer/profile guards, then uses an R2 **create-only** conditional put. A key
cannot be reused with different bytes. Cleanup writes a zero-byte `feedState=erased`
marker to every registered or discovered old-generation object. An already in-flight
conditional put therefore fails even if it arrives after the final cleanup scan.
The marker contains no original body and blocks resurrection; it is not an archive
of user content. Minimum markers/floors cover the 180-day replay/restore window.
Do not physically delete a blocking marker during that window. `retainUntil`
metadata records the earliest eligible removal time; an automatic post-window
marker garbage collector has not been enabled in this delivery.

`POST /internal/feed/admin/v1/status` accepts `{kind,id}` where kind is `sourceEvent`
or `deletion`. `replay` requires `{writerEpoch,kind,id,commandId,operator,reason}`.
Both require the separate **operator** secret, which must never enter Go API
containers or ordinary bridge routing. Replay is limited to dead-letter source
jobs or failed cleanup jobs; live/completed work is rejected. The command ID is a
UUID, exact retries are safe, and operator/reason are durably audited. Only a
protected manual GitHub Actions workflow should expose these operations.

Workerd fault tests cover 100-object R2 pagination, generation preservation,
create-only write races, a real R2 key-validation rejection followed by recovery,
lease expiry, normal release, semantic cleanup refusal, and operator isolation.
These tests do not claim a remote R2 outage or production recovery rehearsal.
