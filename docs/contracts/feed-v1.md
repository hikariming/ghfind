# Feed contracts, version 1

Baseline: `41ce4cd`. Status: accepted implementation contract; environment
verification and compatibility evidence are tracked separately.

## Public HTTP

Every route requires a real GitHub OAuth session and returns `Cache-Control:
no-store`, including errors. Missing or invalid authentication is 401. Retain
existing error codes such as `invalid_body`, `invalid_cursor`,
`taxonomy_version_changed` and `feed_unavailable` where applicable.

| Method / path | Contract |
| --- | --- |
| GET `/api/feed/projects?limit=20&cursor=…` | Limit 1–50; items, requestId, algorithmVersion, taxonomyVersion, nextCursor, degraded |
| GET / PUT `/api/feed/preferences` | Explicit canonical preferences and taxonomy version; atomic replacement |
| GET `/api/feed/tags` | Governed active taxonomy |
| POST `/api/feed/events` | At most 50 typed events, 202 on acceptance, stable event IDs deduplicate |
| PUT `/api/feed/projects/:owner/:repo/state` (PATCH alias) | Preserve existing PUT; exactly one of saved/notInterested plus a valid same-user, same-project impression token |
| DELETE `/api/feed/profile` | Fence immediately, persist cleanup, return deletionId and status; works when serving is off |
| GET `/api/feed/profile/deletions/:id` | Caller-owned durable cleanup status; completed only after all required sinks are clean |
| POST `/api/feed/tags/proposals` | Proposal only; no client authority to approve or mint canonical tags |

Existing public evaluation scores may remain in projects. Never expose ranking
score, feature snapshots, embeddings or selection probability. Do not forward
internal response headers to clients. Bound the actual received body to 128 KiB,
independent of Content-Length. Reject unknown event fields and arbitrary JSON.
Do not record event IP or User-Agent.

## Gateway identity

Header `X-Feed-Gateway` contains `base64url(claims) + '.' + base64url(signature)`.
Signature is HMAC-SHA256 with `FEED_GATEWAY_SECRET` over UTF-8
`feed-gateway-v1\n` followed by the encoded claims. Claims are:

```json
{"version":1,"audience":"feed-api","githubId":123,"login":"example","avatarUrl":"","issuedAt":1788825600000,"expiresAt":1788825630000,"method":"POST","target":"/api/feed/events","bodySha256":"<lowercase SHA-256 of the exact body bytes>"}
```

Times are integer Unix milliseconds. Maximum TTL 60 seconds, recommended 30,
maximum accepted clock skew 5 seconds. Bind method, escaped path, original query
and exact body. Strip client identity/gateway headers and construct an allowlisted
upstream request. Reject invalid audience, identity, time, signature or binding.
Use a dedicated secret of at least 32 bytes, distinct from OAuth, bridge and Feed
token signing secrets. No cookie is sent to Go. Replay-safe mutations additionally
use event/command IDs and durable generation/version checks.

## Internal storage capabilities

Versioned POST `/internal/feed/v1/{operation}`, `X-Feed-Contract: 1`, authenticated
with a dedicated bridge credential. DTOs are defined by
`internal/backend/feed_bridge_contract.go`. Use explicit private snapshot DTOs:
public Go fields marked `json:"-"` must not disappear when sessions are persisted.
Timestamps use RFC3339 UTC; identities and versions must be JSON-safe integers.
Private item ranks are zero-based snapshot positions (0–239), matching the Go
ranker, impression token and PostgreSQL constraint. They are not public scores.

The adapter checks persistent writer epoch and expected user profile/deletion
version for every mutation. Old writers, sessions and delayed messages fail after
a fence. Epoch changes use compare-and-swap. Exact command retries are safe;
same ID with a different payload is a conflict. Reads never turn a tombstoned
user into a fresh generation with reusable old tokens.

Atomic commands include preferences+event+version+outbox, state+event+version,
request+all served items, source finalization+outbox, and deletion fence+cleanup
job. D1 must enforce these with transaction-backed batch, guards and constraints;
PostgreSQL with native transactions. Do not use independent calls to simulate
atomicity. Chunk parameter-limited reads, but do not split atomic writes across
independent transactions.

## Recommendation invariants

Candidates require verifiable submission, a valid completed assessment and
current public eligibility. Recall caps: tags 80, latest 40, quality 20, long-tail
20; semantics may add 80; total at most 240. Missing feature weights renormalize.
MMR defaults to 0.78. Exploration probability 0.10 with at most two exploratory
choices in each 20-item block; any rolling 20 results contain at most two from
the same owner. Short pages are valid when hard constraints exhaust candidates.

Persist the selected sequence for 30 minutes. Page impressions do not change
that sequence. Before serving each page recheck deletion, withdrawal and negative
state; preference version changes invalidate the session. Compute and store the
actual conditional policy probability after eligibility, quota, deterministic
choice and exploration mixture; neither constant 0.9 nor branch probability alone
is a valid propensity.

Explicit preferences override behavioral signals; graph hints are weak priors.
Deduplicated saves, outbound clicks and qualified detail dwell update future
behavior. A bare detail_open is not positive feedback. Attribution links event,
request, served project, source, policy and probability privately.

## Required acceptance fixtures

| Fixture | Required result |
| --- | --- |
| Missing auth; altered path/body/actor; expired gateway claims | 401, no user creation or event write |
| Cross-user cursor, impression or deletion ID | Rejected without disclosing other user's state |
| Assessment without submission receipt | Absent from Feed, original project page retained |
| Existing proposed tags | Remain proposed; no canonical escalation |
| Impression between pages | Stable snapshot order, no stale-cursor error solely due to impression |
| Preference change / withdrawal / deletion between pages | Updated filter or explicit invalidation, never stale eligibility |
| 21 high-quality projects from one owner | Rolling owner cap enforced, including exploration |
| Repeated event; duplicate command with altered payload | One effect; conflicting reuse rejected |
| Save/outbound/qualified dwell vs bare detail_open | Only qualified, deduplicated signals affect later behavior |
| Late job after deletion / stale writer after promotion | Fenced; no user or project resurrection |
| Source commit then queue outage / effect then lost ack | Source remains committed; retry produces one durable effect |
| Mid-batch error / concurrent versions | Entire atomic operation rolls back or conflicts |
| Missing required PostgreSQL test DSN | Required CI job fails; no green skipped contract suite |
| D1-to-PG-to-D1 rehearsal | Primary keys, status, versions, tombstones and checksums agree |
| Worker / Container version mismatch | Readiness or rollout gate blocks traffic |
| Embedding unavailable / incompatible index | Explicit degradation, base Feed works, no fake semantic reason |

## Operational policy

Hot event/request retention is 30 days; archive total retention is 180 days.
Deletion markers cover replay and backup restore windows. Every cleanup sink is
tracked before completed status. Restore into an isolated database, validate,
then promote under a writer fence. Migration may pause Feed writes for at most
two minutes; timeout before promotion reopens the source. Once the target accepts
writes, rollback requires reverse replay and another fenced promotion.

Real OAuth, real evaluation, CF staging measurements, budget qualification and
production readiness must have actual evidence. Mocks, health checks and locally
signed cookies are supporting tests, not substitutes for those gates.
