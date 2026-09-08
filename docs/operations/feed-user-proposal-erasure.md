# User proposal erasure and writer compatibility

PostgreSQL migration 0022 requires **storage writer contract 2**. Public Feed,
operator HTTP, reader and bridge wire contracts remain version 1. Quiesce writers
and advance the writer fence before applying the schema and admitting new code.
The old `998ceda` writer must fail readiness: it lacks privacy enforcement and its
assessment proposal conflict target cannot use the new partial index. Application
rollback must select a tested writer 2 image with the same privacy semantics;
reversing this migration or enabling an old writer is not an application rollback.

User proposal identity is `(actor, commandId)`. Different commands and actors never
share a proposal through its repository/slug natural key. An independent author
record retains the creation profile version until erasure finishes. Ordinary
profile changes preserve a proposal, while deletion's durable profile floor makes
all prior versions inaccessible immediately. Inspection returns `{proposal:null}`;
new create/map/reject commands return `409 governance_proposal_deleted`. Existing
successful operator command receipts contain no original proposal body and may be
retried without rewriting an assignment.

New user reviews assign only `governance:<commandId>` evidence references. The
reviewer's approved canonical definition, aliases and assignment weight/confidence
remain public classification facts. User request labels, evidence and raw slug
remain private. A nullable `origin_proposal_id` records the exact assignment origin;
assessment and later other-proposal assignments replace it explicitly.

Deletion acceptance commits its floor in the primary transaction. Durable cleanup
then advances through assignment evidence, proposal body/slug, submission command
tombstones and author associations, processing at most 100 business records per
step. Empty stages may advance in the same step. The original user body and any
proven legacy copied assignment evidence are erased before the author association
is removed. A later assignment by another author and a newly created generation
survive. A failed or yielded step resumes from the stored phase; completed is
reported only after the existing archive and semantic cleanup phases also finish.

A deleted submission command retains only actor, command ID and generation for
replay rejection. Its proposal ID becomes NULL, body hash becomes `deleted`, and
original creation timestamp becomes the epoch. Reusing that command ID returns
409 even after profile recreation. A new generation must use a new command ID.
This tombstone is distinct from the independent, safe governance audit receipt.

The 0021→0022 migration does not guess historical ownership. It backfills only one
live actor with no deletion history and a command from the proposal's original
transaction timestamp. A remaining later actor on an old shared proposal is not
proof of authorship. Other historical user proposals are quarantined and cannot
be inspected or reviewed. Their raw contents remain available only to a deliberate
storage audit until evidence-backed disposition. This is a migration/promotion
blocker, not proof that earlier completed erasures were complete.

The read-only view `feed.user_proposal_quarantine_summary` reports both total
quarantined proposal rows and `retained_body_proposals`. Retain that count in a
migration manifest. Promotion requires zero retained bodies or an explicitly
reviewed, evidenced cleanup disposition. Normal erased stubs may remain in the
total quarantine count while their retained-body count is zero.

For old assignments, migration replaces raw evidence only when governance ledger
repository, analysis, tag, taxonomy version, weight, confidence and evidence hash
all prove the exact origin. It leaves unproven later overwrites unchanged and
preserves the public classification. Neither restored data nor replay tooling may
bypass the deletion floor, reconstruct proposal associations from deleted command
tombstones, or promote a target with unresolved quarantined bodies.

Validation uses real disposable PostgreSQL and MinIO with synthetic actors and
receipts. It covers migration/repeated migration, ambiguous/missing authors,
legacy evidence copies, later overwrites, 201-proposal bounded cleanup, released
checkpoints, profile recreation, command replay and a directly observed database
lock race between deletion and review. The shared operator/public HTTP fixture
also covers deletion before and after cleanup on both configured profiles. These
fixtures do not constitute production, real GitHub OAuth or deployed CF evidence.
