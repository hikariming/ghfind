# Feed governance v1

This private capability requires **only `FEED_OPERATOR_SECRET`**, POST,
`X-Feed-Contract: 1`, exact paths without query parameters, streamed body ≤32 KiB,
and `Cache-Control: no-store`. It is not a Go public API route, OAuth permission,
or extension of legacy tag review. All DTOs reject unknown fields. One command
handles one proposal or canonical tag; there is no batch approval.

## Routes and DTOs

Paths begin `/internal/feed/governance/v1/`.

`proposal` accepts `{proposalKind:"assessment"|"user",proposalId:string}`.
Unknown IDs return `{proposal:null}`; known IDs return:

```json
{"proposal":{"proposalKind":"assessment","proposalId":"proposal-example","repoKey":"owner/repo","analysisId":"analysis-example","namespace":"use_case","slug":"focused-tooling","labelZh":"工具","labelEn":"Tooling","evidence":["E1"],"status":"proposed","reviewedBy":null,"reviewReason":null,"currentAnalysisId":"analysis-example","currentEvidence":true,"taxonomyVersion":1}}
```

`currentEvidence` requires matching current project analysis, unrevoked submission
evidence, and no moderation removal. It does not imply approval. Normalized
status is `proposed|mapped|rejected|superseded`; D1 assessment `accepted` becomes
`mapped`, while PostgreSQL may retain `superseded`. PostgreSQL assessment selects
only `source='agent'`; user selects only `source='user'`. D1 selects its dedicated
table. Other sources are not silently upgraded. Review retains the proposal's
stored namespace, including legacy inferred namespaces; reclassification is
outside v1.

`review` accepts a strict union with these common fields:

```json
{"commandId":"00000000-0000-4000-8000-000000000001","writerEpoch":1,"expectedTaxonomyVersion":1,"operator":"reviewer-name","reason":"Evidence reviewed individually","proposalKind":"assessment","proposalId":"proposal-example","expectedAnalysisId":"analysis-example"}
```

- `action:"create"` also requires `labels:{labelZh,labelEn,description}` and
  `assignment:{weight,confidence}`. Namespace/slug come from the proposal;
  canonical ID is `namespace:slug`. At least one label must be nonblank.
  The namespace/slug cannot already be a definition or alias.
- `action:"map"` also requires `canonicalTagId` and the same explicit assignment.
  The target must be canonical in the same namespace. A global alias may be
  created, but an existing conflicting alias or different canonical definition
  must not be overwritten.
- `action:"reject"` accepts no additional fields.

`deprecate` accepts `commandId,writerEpoch,expectedTaxonomyVersion,operator,reason,
canonicalTagId`. It has **no `action` request field**. Only canonical→deprecated
is supported, without replacement or bulk reference/preference migration.

`command` accepts `{commandId:UUID}` and returns `{command:null}` or
`{command:<original successful result>}`.

Successful mutation result:

```json
{"commandId":"00000000-0000-4000-8000-000000000001","action":"create","proposalKind":"assessment","proposalId":"proposal-example","canonicalTagId":"use_case:focused-tooling","status":"mapped","taxonomyVersion":2,"appliedAt":1800000000000}
```

Reject uses `canonicalTagId:null,status:"rejected"`. Deprecate omits proposalKind
and proposalId and uses `action:"deprecate",status:"deprecated"`. Time is Unix
milliseconds. Success means this storage transaction completed, not that a
queue or semantic index completed. Exact retries return the same timestamp and
version; no changing duplicate flag is added.

All text fields reject C0 and DEL control characters. IDs are nonblank ≤160 UTF-8 bytes, command IDs UUIDs, versions positive safe
integers. Operator is 1–100 UTF-8 bytes; reason 8–500 and nonblank. Each label is
≤160 bytes, description ≤1000. Assignment values are finite numbers in [0,1].
Creation requires a stored slug ≤80 characters matching
`^[a-z0-9]+(-[a-z0-9]+)*$` and an approved namespace. Inspection bounds evidence
to 64 string entries of at most 256 bytes. No assignment value is inferred.

## Transactions and idempotency

New commands validate identity, writer epoch and active taxonomy CAS in the
same transaction as the changes and receipt. Create/map require a pending
proposal, its analysis ID equal to expectedAnalysisId and the current project's
analysis, unrevoked submission evidence, and no moderation removal. Pre-read
namespace, slug, labels and evidence are rechecked before use. Reject checks
pending state and proposal expectedAnalysisId, and may reject stale evidence;
it never writes project tags/aliases or advances taxonomy.

Create/map write one project tag with explicit weight/confidence and the original
proposal evidence/analysis. D1 uses `admin`; PostgreSQL uses `editor`. D1 replaces
its single `(repo,tag)` row atomically; PostgreSQL must keep one effective
reviewed assignment despite its source-aware primary key. The selected proposal
must not increase the project beyond 100 effective canonical tag IDs, counting
only current-analysis assignments. Existing effective-tag replacement is
allowed at capacity; exceeding capacity returns `governance_tag_conflict`.
The selected proposal
becomes mapped (D1 assessment physically accepted). No other same-slug proposal
is approved, rejected or superseded. A new alias affects **future assessment
resolution**, which is distinct from approving existing pending evidence.

Create/map/deprecate retire the active taxonomy and activate version+1. Reject
records the unchanged active version. A unique active-version constraint and
transaction CAS serialize mutations. Already resolved proposals and noncanonical
deprecation targets reject new commands. Failure rolls back tags, aliases,
proposal state, taxonomy and audit together.

Command identity is SHA-256 of validated logical mutation canonical JSON:
recursive sorted object keys, preserved array order, UTF-8, JSON string escaping
and ECMAScript number serialization (the RFC 8785 subset used by these DTOs).
Deprecate includes its implicit action in this normalized object. Go default
HTML escaping is not suitable. A UUID reused with changed action, actor, reason,
assignment, target or expected version conflicts; wire object-key order does not.
Exact persisted retries remain valid after epoch/taxonomy changes or erasure of
the proposal and return the first result without reapplying writes.

The audit keeps operator/reason, digest, target, analysis/evidence hash,
assignment, versions and immutable result. Raw user proposal bodies are not
copied into the ledger. Evidence hashes identify the adapter's stored evidence
bytes and are opaque audit references.

Errors use `{error:string}`. Invalid DTOs return 400 `invalid_request`; unknown
proposal mutations return 404 `governance_proposal_not_found`; unknown operations
return 404 `operation_not_found`. Conflicts return 409:
`governance_command_conflict`, `writer_epoch_changed`, `taxonomy_version_changed`,
`governance_proposal_changed`, `governance_not_pending`,
`governance_evidence_changed`, `governance_tag_conflict`. Invalid stored evidence
on inspection returns 409 `governance_evidence_invalid`. Storage errors are 503
without SQL, credentials or proposal bodies in logs.

## Lazy taxonomy invalidation

Governance does not update every user/session. FeedUser.taxonomyVersion returns
the global active version; the user row retains the last explicit-preference
version. Preference and positive/negative tag reads use current canonical tags.
Deprecated tags remain historical references, not active filters or preferences.

Session writes and request persistence check active taxonomy inside their write
transaction. Session reads require the snapshot taxonomy to equal active. Go
compares session/current taxonomy before its empty-tail response and normal page
service; stale snapshots yield feed_cursor_expired. Events and state commands
reject attribution through old-taxonomy requests, including exact event/state
retries. Profile version/floor checks remain independent. PostgreSQL locks active
taxonomy for these transactions; governance takes the conflicting lock. D1 uses
batch/single-query predicates. Preflight-only checks are insufficient.

Feed migration 0009 adds command/guard tables and a unique active-version index;
it changes no existing taxonomy/proposal facts or user permissions. Protected
entry routing/workflows, both-store checks and lazy-invalidation integration are
required before activation. Local implementation performs no remote review.

## Activation and rollback boundary

This capability remains staging-only until release gates cover governance fences
on both profiles. Although migration 0009 is additive and the structural contract
remains v1, advancing taxonomy changes serving behavior. An older adapter without
lazy taxonomy checks is **not** a compatible application rollback target after
governance is used. Phase 5 must restrict the permitted rollback SHA window to
implementations with these fences. Structural compatibility does not imply
business compatibility: an application rollback must not reactivate old sessions
or event attribution. Release manifests and protected Actions must enforce the
allowed implementation window.
