# Feed stage 4 source and recovery handoff

Updated 2026-09-09. Main integration baseline:
`2028e1a48365ab26f88492cfd37a7c51b2cd4554` (the stage-3 merge).
The stage-4 branch incorporated that baseline at `bc46f93`; its implementation
head before this documentation delivery is
`d04f5527b95e9f8045974d025de5ec83bb579670`.
[PR #249](https://github.com/hikariming/ghfind/pull/249) remains draft and unmerged.
These are implementation and evidence handoff points, not a claim that stage 4
has met every acceptance criterion or deployed to production.

Storage job/checkpoint/replay capabilities came with stage 2; private source
capabilities, queues and executor dispatch came with stage 1. This stage connects
the existing assessment transaction to those capabilities and adds a strict
snapshot format plus a real isolated D1 restore/deletion drill. The first Go
production runtime cutover must continue using the existing Feed D1 fact source.

## Delivery and commit boundaries

| Stage-4 commits                 | Delivered boundary                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `341a9e9`                       | Server submission receipt, assessment completion and core outbox transaction; no synchronous Feed/Queue dependency |
| `7d7ecd2`, `e8809f5`, `a8085d2` | Versioned offline snapshot format, isolated local D1 restore and preserved schema-7 evidence                       |
| `059ee2d`                       | Retry valid-artifact persistence without rerunning the assessment or invoking the legacy Feed writer               |
| `1562113`, `47d9e3d`            | Source/recovery CI checks and pinned local runtime installation                                                    |
| `9123489`, `79d70c5`, `22c198e` | Fixed schema-9/10 registries, governance restoration and older artifact compatibility                              |
| `63d4073`, `d04f552`            | Schema-11 writer/tombstone semantics and real proposal-privacy restoration with bounded cleanup                    |

The source seam defaults off. `FEED_SOURCE_OUTBOX_ENABLED=true` requires reviewed
core migrations 0005/0006; these remain outside the existing production
application migration allowlist. Already-applied core migration 0002 is preserved.
Explicit app submission commits its receipt with the source run before creating
an external thread. Completed-run reuse records that explicit request;
background reconciliation does not manufacture historical submission evidence.
Assessment facts, completion and outbox commit in one core transaction. Feed
storage and queue availability are outside that transaction.

In outbox mode, finalization never calls the legacy Feed projector, including a
best-effort call after commit. Legacy projection, reconciliation and tag-review
writes reject before storage access when outbox mode or the Go backend is enabled.
A valid artifact whose core commit fails remains in `finalizing` on its original
run/thread and returns `analysis_persistence_unavailable` (503). Retrying persists
that same result, even after the earlier evaluation execution deadline. Invalid
artifact identity remains terminal. This process guard does not replace the
writer-epoch fence required for a later database promotion.

## Versions and retained evidence

The public/HTTP/read contract remains **1**; portable storage writer contract is
**2**. Feed D1 migrations are through **0011**, while its actual runtime control
schema remains **7**. PostgreSQL migrations are through **0022**. Core source and
replay migrations are **0005/0006**. Snapshot registries accept exactly **7, 9, 10
and 11**; their physical schema, migration hashes and reader/writer compatibility
are checked explicitly. Schema 11 has **45 tables and 350 columns**. Its
proposal-command zero timestamp is allowed only with the complete minimal
tombstone (`proposal_id=""`, `payload_hash="deleted"`); other zero timestamps and
partial tombstones reject. Schema-7/9/10 fingerprints remain unchanged.

The following original machine reports are preserved byte-for-byte. They contain
synthetic identifiers, hashes, counts and bounded test outcomes, not credentials
or raw snapshot row/object payloads. Their original temporary paths remain as
provenance and are not a durable backup destination.

| Report                                                                   | Actual evidence boundary                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Schema 11](../evidence/feed-local-d1-recovery/2026-09-08-schema11.json) | Adapter `7f660f2`, 45 tables / 350 columns / 76 rows; writer 2; full-row and file-hash restore; governance/proposal ownership; post-backup deletion overlay; bounded primary and empty-local-R2 cleanup |
| [Schema 9](../evidence/feed-local-d1-recovery/2026-09-08-schema9.json)   | 45 tables / 348 columns / 73 rows; governance and deletion-fence restore; physical cleanup remained pending                                                                                             |
| [Original schema 7](../evidence/feed-local-d1-recovery/2026-09-08.json)  | 43 tables / 321 columns / 63 rows; historical baseline, preserved unchanged                                                                                                                             |

The schema-11 implementation passed the recorded **24-test** snapshot/local-D1
suite with zero skips. A retained run completed its assertions in 2,683 ms; this
small local fixture duration is not a production RTO. Actor 303's actual
pre-backup cleanup produced a tombstone which was exported and restored. Actor
202's pending and reviewed proposals were restored with their authors, commands
and assignment origin/reference. After a separately captured deletion overlay,
both proposals inspected as null and new reviews returned 409. Exact prior
governance retries returned their safe receipt without rewriting any row.

The target's later bounded cleanup erased raw slug/labels/evidence and old
proposal-command links, removed old authors, retained independently reviewed
canonical assignment weight/confidence and preserved a new-generation proposal.
Requests/sessions were created under taxonomy 3 after both reviews; their later
deletion rejection cannot be attributed to a stale taxonomy. Actor 404 separately
proved lazy taxonomy behavior (stored version 1, read version 3). The final
quarantine inventory retained one unowned historical body; its disposition is an
open promotion gate. See the [recovery evidence narrative](../operations/feed-local-recovery-evidence.md)
and [restore procedure](../operations/feed-backup-restore.md).

## Source fault evidence

The [service-level finalization fixture](../../src/lib/__tests__/feed-source-finalization.test.ts)
uses an actual local core SQLite/libsql database and the actual reconciliation
service, with synthetic Mosoo artifacts and a stubbed external boundary. It
injects an outbox trigger abort and verifies zero assessment/outbox commits,
retryable 503 and the preserved `finalizing` run. After removing the failure and
moving the original start time beyond the evaluation deadline, reconciliation
completes with exactly one assessment/outbox and no new external evaluation.
Both throwing and permanently stalled legacy Feed functions are never invoked.
A forged artifact analysis ID still produces a terminal failure without publication.

The [source outbox fixture](../../src/lib/__tests__/feed-source-outbox.test.ts)
also covers receipt/run rollback, explicit reuse, submission-before-external-call,
immutable delivery identity, lease/acknowledgement races and retry exhaustion.
Actual [workerd source tests](../../platform/feed/tests/source.test.ts) and
[core replay tests](../../platform/feed/tests/source-replay.test.ts) exercise
bounded authenticated capabilities, actual artifact hashing, atomic receipt
rollback and audited recovery of exhausted core delivery. Their scope and
reproduction belong to [source protocol v1](../contracts/feed-source-events-v1.md).
These fixtures do not establish real Mosoo completion, remote CF Queue execution
or production fault recovery. This documentation-only delivery reruns no heavy
suite and cannot stand in for exact-head CI on the integrated stage-4 PR.

## Open gates and next-stage inputs

Stage 4 is implemented in bounded local pieces; complete operational acceptance
remains open. Before stage 5 admits production traffic, retain evidence for:

1. Exact integrated PR-head CI after the main/schema-11 merge, followed by the
   actual isolated CF staging release, compatible Go/adapter image digests,
   readiness, lifecycle and bounded cost/latency evidence from stage 1.
2. Real source-commit/delivery failures, duplicate or lost acknowledgements,
   executor restart, retry exhaustion, DLQ/parking recovery and operator replay
   through remote CF Queues. Log output is not proof of delivered alerts;
   notification delivery and responsibility remain separate evidence.
3. Real R2 object export, transfer, checksum verification and restore, including
   post-snapshot deletion markers and complete incremental Feed changes. An empty
   local bucket cleanup does not prove object-byte recovery. The recorded core
   source watermark does not cover all user-state writes.
4. D1→PostgreSQL→D1 mapping/replay, write-fence and epoch promotion, compatible
   application rollback, and measured RPO ≤15 minutes / RTO ≤60 minutes. Historical
   unowned proposal bodies need a defensible disposition before promotion.
5. Real GitHub OAuth and paid assessment E2E, complete deletion/recovery and the
   controlled production canary through GitHub Actions. Existing Railway backup
   failure and legacy-service disposition are not repaired by these local results.

Snapshots and reports retain `promotionReady:false`. The immediate deletion
checkpoint has `cleanupCompleted:false`; later schema-11 privacy assertions prove
primary and empty-local-R2 cleanup only. No production schema, records, routing,
remote resources or credentials are changed by this evidence/documentation work.

Stage 5 receives fixed schema/contract versions, retained local evidence, the
source fault fixtures and the remaining gates above. Resource identities and
historical credential/protection gaps are in the
[staging resource audit](../audits/2026-09-08-feed-staging-resources.md); reread them
through the release owner before any live operation. Register a writer-2 rollback
SHA/digest window with the same privacy/taxonomy semantics. Rollback keeps one
fact source and a compatible Go/adapter pair; an old unfenced writer is not a
rollback target. Do not reverse destructive migrations, promote this synthetic
fixture, or flip storage profiles after the target accepts new writes.
