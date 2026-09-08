# Feed stage 2: storage foundation handoff

Base: `38985cc0bcb811801f427e162bce3dd04ed062ee` (stage 0 merge).
PR: <https://github.com/hikariming/ghfind/pull/246>. The merge SHA and final CI run
must be recorded from GitHub after this PR passes; this document does not claim
that an open PR has merged.

## Delivery and ownership

The ordered commits introduce capability-oriented Go ports, strict private D1/R2
HTTP commands, PostgreSQL transactions and a real S3 archive adapter. Shared
fixtures exercise the Go API over both profiles so its request, event, session
and deletion semantics cannot silently diverge. The portable API is an opt-in
constructor in this foundation; this PR does not wire the Next gateway or deploy
an independent runtime. Durable task, delivery and cleanup storage commands are
included because those protocols require atomic storage operations. Source-core
outbox finalization, queue consumers and runtime scheduling belong to stage 4.

Commit groups are inspectable with `git log --reverse --oneline origin/main..HEAD`.
The principal later groups add generation-scoped S3/R2 cleanup, complete served
selection probabilities, and explicit reader/writer compatibility. They preserve
the original per-purpose commit boundaries instead of squashing the implementation
into one unexplained change.

Contract versions: public/storage/archive/executor 1; portable algorithm
`baseline-v2-portable`; taxonomy 1; PostgreSQL migrations through
`0019_feed_schema_compatibility.sql`; Feed D1 through
`0007_feed_schema_compatibility.sql` (runtime schema 7). Additive future migrations
are accepted only with an explicit compatible reader/writer record; incompatible
contracts or missing known migration history fail readiness. Legacy PostgreSQL
initialization retains its stricter migration policy.

The previously deployed core `0002_user_resume_libraries.sql` is preserved from
its verified dev history. `ops/feed-application-schema-release.json` fixes exact
filenames and hashes allowed in the existing Next production/dev deploy paths.
New portable schemas cannot be applied merely because this foundation is merged.
This also protects the shared dev/production core D1. No historical submission
is inferred and no pending proposal is promoted.

## Reproducible evidence

Use the required storage job in `.github/workflows/ci.yml`: a disposable pgvector
PostgreSQL service, actual MinIO, and actual local workerd D1/R2 bindings. Missing
required PostgreSQL or S3 configuration is a failure. MinIO and PostgreSQL images
are pinned to digests; no production service or remote D1 binding is used.

On 2026-09-08 the local workerd suite passed 46 tests in six files. The shared Go
API and archive fixtures then passed both `postgres` and `cf_d1_r2`, including an
exact 4 MiB archive payload, create-only conflicts, deletion visibility, delayed
writes and new profile generations. The approved-schema suite passed both tests,
and the application release-workflow contract passed. Final full CI on the PR's
exact head is required in addition to these local results.

Commands:

```sh
pnpm -C platform/feed typecheck
pnpm -C platform/feed test
# Set disposable FEED_TEST_DATABASE_URL and FEED_TEST_S3_* first.
FEED_REQUIRE_POSTGRES_TESTS=1 FEED_REQUIRE_S3_TESTS=1 go test ./...
node scripts/test-feed-crossprofile.mjs
node --test scripts/feed-platform-schema-release.test.mjs
pnpm ci:check-cf-release-workflow
pnpm typecheck
pnpm lint
pnpm test
```

These checks cover constrained pagination, 240-key reads, rollback, concurrent
profile versions, command identity, immutable request audits, hard eligibility,
rolling owner/exploration quotas, complete conditional probability and deletion
fences. There are no event IP, User-Agent or arbitrary client-JSON fields.

## Acceptance boundary and next stage

Local workerd is real Worker/D1 execution, but is not remote CF staging evidence.
Remote migrations, capacity/latency, live Queue recovery, real OAuth/evaluation,
backup restore and D1→PostgreSQL→D1 promotion remain explicit gates. A separate
600-second PostgreSQL capacity baseline found p95 above 800 ms; performance
optimization and another measurement must precede release. Passing this storage
foundation does not authorize production Feed cutover.

No remote resource IDs, credentials or active versions change in this PR. Existing
Next Feed remains the production rollback point on the same current D1. Revert
application code or deploy the previous compatible application via Actions; do
not reverse migrations or drop tables. Re-read production versions before release.

Stages 3 and 4 receive the stable ports, fixtures and schema compatibility range.
Stage 1 receives a private adapter build and the explicit approved-schema boundary.
The final stage 5 gate must combine their actual staging evidence and versioned
release manifest before any traffic or writer promotion.
