# PostgreSQL operator governance

The standalone PostgreSQL executor can expose the same four private governance
commands as the Cloudflare adapter. Configure a distinct `FEED_OPERATOR_SECRET`
(at least 32 bytes) on the PostgreSQL worker and use the authenticated POST
capabilities under `/internal/feed/governance/v1/`. The worker must already have
its source, durable task and archive dependencies configured; its readiness
continues to check those dependencies. The public Feed API does not register
these routes. No operator secret is injected into Cloudflare Containers.

The operator secret must differ from executor, source, bridge, gateway and token
signing secrets. Missing configuration does not register the capability. The
handler rejects unknown fields, wrong methods, unsupported paths, query strings,
wrong `X-Feed-Contract`, and bodies larger than 32 KiB. Text rejects C0/DEL and
uses UTF-8 byte limits. Never put credentials or raw request bodies in logs.

Use the `Feed governance v1` contract for inspection, individual review,
deprecation and command lookup. Review one immutable proposal with an explicit
reason and, for create/map, explicit weight/confidence. A command UUID denotes
one logical request; retain it and the same normalized payload across transport
retries. An exact persisted retry returns its original timestamp and result,
including after writer/taxonomy advancement or deletion of the proposal. Changing
any logical field requires a new command UUID and fresh expected versions.

PostgreSQL migration 0021 adds an independent audit ledger and a nullable
submission-evidence revocation marker. It approves no existing proposal and
revokes no existing receipt. It does not create a withdrawal endpoint. As with
other schema changes, apply it through the migration/release workflow, never by
runtime DDL. Do not use the legacy batch-review API for this capability.

Migration 0022 adds durable user-proposal authorship and exact assignment origin,
separates user proposal identities and upgrades storage writer compatibility to
2. The HTTP contract remains 1. Apply this with an explicit writer pause/fence and
a matching executable: the old projector's natural-key conflict SQL is no longer
compatible. A pre-privacy image such as `998ceda` cannot be an allowed rollback
target. Historical bodies with unprovable authorship stay hidden and require a
recorded disposition before promotion; they are not silently attributed to the
current profile or counted as successfully erased.

Each mutation takes the `runtime_control` row's exclusive lock; portable writes
hold its shared lock until their transaction commits. A changed epoch or active
taxonomy rejects a new command. Taxonomy changes, one proposal, one effective
project-tag assignment and its audit receipt commit together. Active taxonomy
increments for create/map/deprecate; reject can resolve an outdated proposal
without changing taxonomy or assigning its evidence to a project.

Current, canonical tags from the current project analysis alone contribute to
recall, response hydration, negative filtering and new behavior materialization.
The command cannot create a 101st effective tag. Replacing an already-effective
tag at 100 is allowed; replacing a stale-analysis row does not bypass the limit.
A map/deprecate target must be canonical in the active taxonomy range. Historical
rows remain for evidence; they are not automatically promoted or reassigned.

User rows retain their last explicit preference taxonomy. API user reads return
the current active taxonomy. Session get/put and request persistence reject
stale taxonomy, and Go rejects old cursor snapshots before even an empty tail
response. State/events through an old-taxonomy served request return
`taxonomy_version_changed`. Profile generation/floor checks remain independent.

Local verification uses real disposable PostgreSQL and S3 services. In addition
to normal review, tests exercise stale evidence, alias conflicts, source scoping,
control characters, JCS identity, exact retries after erasure, audit insert
failure rollback, both directions of the control-row lock, stale sessions and
attribution, negative-tag deprecation, and the 100-current-plus-one-stale boundary.
The operator workflow, both-profile HTTP contract and protected deployment remain
separate release gates. Local tests do not authorize or perform remote reviews.
