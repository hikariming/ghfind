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
manual dead-letter replay and deletion cleanup scheduling remain integration work.

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
created profile. The baseline adapter does not claim that cleanup has run.

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
