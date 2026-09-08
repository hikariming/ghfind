# Feed stage 3 implementation handoff

Base: `b47b2ee4ab94fb2f833a3d613886ea41524c03bd`, the merged isolated runtime
foundation. This delivery adds the opt-in authenticated Next gateway, governed
taxonomy operations and measured recall/ranking improvements. Production routing
continues to default to legacy. The public/HTTP/read contract is 1, the storage
writer contract is 2, and the algorithm is `baseline-v2-portable`. PostgreSQL is
through 0022; D1 is through 0011, with runtime control value 7 and an explicit
writer-2 compatibility window. These migrations remain outside the production
application's approved schema manifest.

## Commit boundaries

1. `b1d2b3a` / `c16693a`: signed same-origin gateway and public proposal/deletion
   routes. Existing GitHub OAuth authenticates the user; the gateway strips client
   identity, cookies and forwarding headers, then signs a 30-second request,
   audience and body-bound context. Requests and responses have byte/deadline
   limits. Invalid Go configuration fails closed.
2. `fe4ad03` / `56dd3bb` / `217ded3`: measured recall and ranking improvements.
   The ranker caches maximum selected-item similarity. Complete output remains
   equal to a frozen pre-optimization oracle on each tested CPU architecture;
   cross-architecture float-only normalization accommodates observed sub-ULP
   differences without changing production math. PostgreSQL and D1 retain hard
   filters before bounded candidate limits and use indexed sparse-tag recall.
3. Governance commits through `b82a33e`: operator-only read/review/deprecate and
   immutable command receipts, exact retries, independent secrets, strict Unicode
   and numeric handling, bounded HTTP, real transport timeouts, and lazy taxonomy
   fences. Canonical tags from the current assessment alone affect recall,
   hydration and behavior. At most 100 effective canonical tags can be assigned.
4. `ea9a82d`: private sessions retain assessment and projection identity. Missing
   identity or changed published content expires the cursor with 410. The bounded
   availability check and atomic request write both compare identities; the latter
   prevents a projection change between checking and recording a served page.
5. `d1bde39` / `9b77315` / `0f72b56` / `62038fc` / `fd6a66e`: user-proposal
   authorship and deletion fences, controlled evidence references, bounded erasure
   of original text and request lineage, nonshared proposal identities, historical
   quarantine inventory, and readiness that verifies the actual privacy schema.
   `efcbcad` runs the same deletion/governance interactions through both profiles.

Existing pending proposals are not automatically approved. Operators review one
proposal at a time through the separate protected capability; neither an ordinary
user nor the Go API gains that credential. Public Actions artifacts contain only
allowlisted identifiers, hashes and receipts, never raw evidence or review text.
There is no new Feed page, moderation UI, Next catch-all rewrite or semantic recall.

## Evidence and acceptance boundary

CI passed on earlier exact heads `217ded32e67ea72f7638651e9fe3de4e35ed87a4`
([run](https://github.com/hikariming/ghfind/actions/runs/34187476125)) and
`b82a33ea9732469889c5dc942c4c7e3e3c30c4f4`
([run](https://github.com/hikariming/ghfind/actions/runs/34189680276)). Those runs do
not establish acceptance of the later privacy/session fixes. The final PR head
must pass its own application, storage and image-build CI before merging.

The integrated local implementation at `7f660f2` passed all Go packages with actual
PostgreSQL/pgvector and MinIO, 103 real workerd/D1 tests, adapter typecheck/build,
and identical API/archive/governance contracts through PostgreSQL and workerd.
These include deletion before/after approval, exact replay after deletion,
recreated profiles, later assignments surviving another author's cleanup, actual
transaction-lock contention, old cursor and attribution rejection, and request
persistence after a concurrent projection. TypeScript/lint and 721 application
tests passed on the unchanged application/gateway source. The runtime has 34
transport/routing checks; the operator CLIs have 13 checks. No UI presentation
changed, so the theme-layout checklist is not triggered.

The retained 50k-project/5k-user/1m-event local capacity baseline failed: 6000
offered requests over 600 seconds, p95 2573.884 ms, 421 concurrency rejections.
The optimized `8ec38e7` retest produced 5981 HTTP 200 responses, p95 97.533 ms and
19 concurrency rejections. Its lower latency is evidence of the optimization,
not full reliability acceptance. The privacy/session writer-2 baseline requires
its own measured run; local data does not establish CF latency, cold start or cost.

Unknown historical authorship is not guessed. Remaining unowned proposal bodies
are hidden from inspection/review and counted by fixed quarantine queries. A
nonzero retained-body inventory blocks production/migration promotion until its
disposition is evidenced. Normal redacted rows are not themselves a blocker.
Real GitHub OAuth, real assessment execution, remote CF lifecycle/load/cost,
complete recovery and controlled production cutover remain integration gates.

## Handoff to stages 4 and 5

Stage 4 receives the writer-2 migrations, proposal erasure contract and private
session identity fixture. Its recovery registry and actual restore drill must
include schema 11; an older schema 7/9 report cannot satisfy that gate. Stage 5
must also receive stage 1's actual CF runtime evidence before admitting traffic.
The initial production runtime cutover keeps the current Feed D1 fact source.

Before this incompatible writer transition, quiesce writes, fence the old epoch,
apply/verify migrations, and start the paired Go and adapter SHA before reopening
writes. An old adapter's strict DTO parser cannot accept the new session identity
fields. A pre-privacy writer, including `998ceda`, is not a compatible rollback
image. Register and exercise a writer-2 rollback SHA window with the same privacy
and taxonomy semantics; never switch the store-profile variable to reverse data
writes. Exact ready versions and registry image digests belong in the later
release manifest. This PR creates no remote credentials/resources and enables no
production Go traffic or production governance target.
