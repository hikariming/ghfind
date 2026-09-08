# Feed stage 3 implementation handoff

Base: `3cdb66cc21028e1b7159ce30f769ff8fcd9b4d33`, the merged stage 2 storage
foundation. This PR adds the authenticated Next gateway and publishes the new
proposal/deletion contracts, plus measured-hotspot ranking/recall optimizations.
It does not activate production Go routing. Public/storage contract stays 1,
taxonomy stays 1, portable algorithm stays `baseline-v2-portable`; PostgreSQL
adds index-only migration 0020 while D1 adds index-only migration 0008 and retains runtime schema 7.

## Commit boundaries

1. Signed same-origin gateway: authenticate with the existing GitHub OAuth
   session, strip all client identity/forwarding/cookie headers, sign a 30-second
   request/user/audience/body-bound context, limit streamed bodies and responses,
   preserve no-store and existing route methods. `FEED_BACKEND` defaults to legacy;
   invalid Go configuration returns unavailable instead of silently changing stores.
2. Public proposal and caller-owned deletion status documentation; normalize D1
   pending state to the same queued public status as PostgreSQL. Shared fixtures
   compare deletion response contents, not merely HTTP 200.
3. Freeze three complete private ranking-output hashes before optimizing; cache
   each candidate's maximum similarity to selected items without changing output,
   probabilities or quota rules. PostgreSQL recalls use ordered index scans with
   correlated provenance checks; 0020 supplies the full quality ordering index.
   Hard filters still precede the final candidate limit. D1 skips empty tag
   recall and chooses an indexed sparse-tag plan using a bounded probe; the probe
   never truncates business candidates. Discovery gets a matching partial index.

The Go API, durable sessions, governed proposals, behavior effects and complete
conditional probability implementation were introduced with the stage 2 shared
storage fixtures. This PR exposes them through the stable Next gateway when an
explicit later rollout enables the independent runtime. It does not introduce
Next catch-all rewrites, semantic retrieval or migration of unrelated APIs.

## Evidence and next entry conditions

Stage 2 CI passed on exact head `0bfdd94fe684e9c7ac2cb6859a8fdf67fad5df9d`
and merged as the base above. This PR must pass its own exact-head CI: application
checks and the real PostgreSQL/MinIO/workerd contracts. The storage CI now runs
all backend tests against actual dependencies so future contract tests cannot be
silently omitted by a stale name filter. Cross-profile API/archive tests have
another required workerd step.

The earlier local 50k-project/5k-user/1m-event capacity baseline failed: p95
2573.884 ms with 421 of 6000 offered requests rejected by the concurrency bound.
A CPU profile attributed 89.76% of sampled CPU to ranking. Fixed private-output
hashes stay unchanged with the similarity cache; a full 600-second capacity
retest is required and tracked independently. Microbenchmarks and query plans
are not end-to-end SLO acceptance.

No UI presentation changed; the theme-layout checklist is not triggered.
Typecheck, lint, gateway authentication/size/header tests, complete ranking golden
fixtures and both storage profiles remain required. Real OAuth, real assessment,
remote CF performance, queue recovery, migrations and controlled production
cutover belong to the integration gates and are not replaced by synthetic signing.

Stage 5 receives stable route/identity contracts and an opt-in gateway. It must
first combine stage 1 deployment evidence and stage 4 recovery evidence. Production
keeps its current Feed D1. Application rollback uses a compatible binary/gateway
on that same fact source; it never changes `FEED_STORE_PROFILE` to reverse writes.
The previous application SHA is the rollback anchor until a later release records
a new manifest. No credentials or remote resource changes are part of this PR.

The operator governance command and lazy taxonomy-version fences are still being
implemented in this draft. Keep this stage open until both stores pass those
contracts; proposal submission alone is not a completed moderation workflow.
