# Portable Feed session projection identity

This additive contract-1 extension pairs the Go API and D1 capability adapter in
one release. It introduces no migration and does not change the public Feed DTO,
ranking policy, probability calculation or 30-minute snapshot lifetime.

## Identity and atomic service boundary

Every portable candidate and private session item carries `analysisId` and
`sourceHash`, copied from the catalog's existing `analysis_id` and `source_hash`.
The first distinguishes assessments; the second distinguishes content projections
of the same assessment. Both are excluded from the public project JSON, along
with internal ranking scores and features. Existing public assessment scores keep
their existing meaning.

Before serving a page, Go checks every remaining sampled item in a single bounded
capability call (maximum 240 items). `projects.available` accepts the legacy
`{githubId,repoKeys}` form for existing internal callers, and the portable form:

```json
{
  "githubId": 42,
  "repoKeys": ["owner/repo"],
  "identities": [
    {
      "repoKey": "owner/repo",
      "analysisId": "analysis-1",
      "sourceHash": "source-hash"
    }
  ]
}
```

The two lists must contain the same unique repository keys. Identity availability
requires an exact match of both fields plus all existing publication, provenance
and negative-preference filters. D1 drives the query from the bounded JSON list
and looks up projects by primary key. PostgreSQL uses one bounded array query.
Neither implementation issues a network call for each project.

`requests.save` independently repeats the check for every served item inside its
existing atomic write. PostgreSQL locks project rows in stable key order through
request/served-item commit. D1 validates the fields inside the same batch as the
request and served-item inserts. A failed check writes neither record. An exact
request retry must still pass current identity checks; an old success cannot
serve stale content after a projection update.

A changed identity, withdrawal or missing identity in an old private snapshot
expires that session with HTTP 410 (`feed_cursor_expired`). The client starts a
new session. Go never removes sampled items or silently changes their order or
conditional probabilities to repair an old snapshot. The legacy key-only store
interface remains available, but the standalone runtime requires the separate
identity-aware capability and cannot fall back to it.

## Paired rollout and rollback

The adapter at baseline `30b3d4f` strictly rejects the new availability fields. Its
existing `contractVersion: "1"` readiness response is **not** evidence that it
supports this extension. Release evidence must record the adapter SHA and Go
image SHA/digest from this change together and run the shared API fixture against
that pair. Do not deploy the new Go API against the old adapter.

Apply the paired adapter before routing to the paired Go runtime, while the
portable entry remains gated. Older Go candidates omit identity and are refused
at the new served-request boundary; consequently this is not a mixed-version
serving compatibility window. The existing Next gateway may keep routing to the
old Feed runtime until the new pair is ready. An application rollback must use an
identity-aware compatible pair or return to the explicitly gated old runtime;
rolling back only one member is not an accepted serving state. Stored snapshots
without identity intentionally return 410 instead of being upgraded in place.

No migration, source hash rewrite, historical provenance approval, database
promotion or production operation is part of this change.

## Local verification evidence

On 2026-09-08 the shared `TestPortableAPIBothProfiles` ran against a newly created
local PostgreSQL/pgvector database on port 55443 and fresh workerd/D1 bindings. The
fixture uses actual job claim, projection apply and completion commands. It proves
old published-item pagination expires, new sessions return current content and
canonical tags, missing-identity persisted snapshots expire, and a source-hash-only
update invalidates the prior projection. It also checks the race between a
successful availability read and request persistence, including stale exact
request retries. PostgreSQL row counts and the separate real D1 executor test
confirm that refused new requests create no request/served-item records.

The fixture is invoked by `scripts/test-feed-crossprofile.mjs`; the full wrapper
also requires its separately configured local S3 archive fixture. For this bounded
change the existing wrapper was copied temporarily with only its Go test selector
narrowed to `^TestPortableAPIBothProfiles$`, leaving fresh local D1 setup, strict
PostgreSQL requirements and cleanup unchanged. This is local integration evidence,
not real OAuth, remote staging, production latency, capacity or rollout evidence.
