# Feed source event protocol v1

Apply core migration `0005_feed_source_outbox.sql` before setting
`FEED_SOURCE_OUTBOX_ENABLED=true`. It defaults off. Preserve the original
already-applied `0002_user_resume_libraries.sql` exactly. The source seam does
not run DDL or access Feed storage during assessment commits.

An explicit `POST /api/project-analyses` records a server receipt even when it
reuses a completed run. Anonymous submission remains supported; the receipt
does not pretend to identify an OAuth user. Historical completion does not
create a receipt. Receipt identity is stable per analysis and repeated calls do
not inflate the outbox. Agent/backfill source kinds require separate protected
entry points; clients cannot choose them through the public submission route.
For a newly accepted run, the POST route passes a server-only `appSubmission`
option. Run creation (or active-run deduplication), receipt insertion and the
returned run snapshot share a core database batch before any external Mosoo
thread creation. A failed receipt write rolls back the new run and prevents the
external call. Background creation/reconciliation does not set this option.

Assessment finalization batches its existing results, guarded run transition
and source outbox in the same core transaction. The CHECK guard aborts the entire
batch on a lost state race. Existing scores, boards and artifacts are unchanged.
The legacy best-effort Feed projection may fail after that transaction without
undoing the source facts. A completed-run receipt batches the receipt and event
together, so a submission/finalization race is covered in either ordering.

Queue envelope:

```json
{"contractVersion":1,"eventId":"assessment.completed:analysis-id:content-hash","aggregateKey":"owner/repo","sourceVersion":123,"kind":"assessment.completed","analysisId":"analysis-id","receiptId":"app:analysis-id","sourceHash":"content-hash","occurredAt":1788825600000}
```

`sourceVersion` is the monotonically increasing core outbox sequence. The
consumer fetches the identified source facts through a bounded capability and
verifies receipt, analysis hash, completion and current eligibility. The queue
does not carry unbounded assessment JSON. A stale event cannot replace a newer
project version. A receipt satisfies only submission evidence, never governance
or assessment eligibility. Supersession also checks the replacement run's actual
JSON SHA-256, selected together with its completed run/outbox/receipt identity;
matching stored hash columns alone cannot cause an old task to be completed.

Claims are indexed, at most 100, with a 60-second lease and maximum ten attempts.
Retry delay doubles to a five-minute ceiling. Publication completion checks the
lease token and expiry. Losing acknowledgement may redeliver the same event;
execution must be idempotent and durable before queue acknowledgement. A worker
lost on attempt ten becomes a persisted failed record after lease expiry.
Operator replay retains identity and source version and records its reason,
count and timestamp. Stage 4 core migration `0006_feed_source_replay_audit.sql`
adds a stable command/actor audit. Protected admin `kind:"coreSource"` uses a
positive decimal sequence ID and deliberately has no Feed writer epoch. Only
failed source delivery can accept a new command; exact retries remain accepted
without restarting subsequent work. Source cron then publishes the unchanged
event. `ok:true` means command acceptance, and source `delivered` means queue
publication, neither proves Feed execution. No unbounded automatic replay or
catalog scan is used.

Local source-seam tests cover transaction rollback, explicit reuse, downstream
unavailability, deduplication, lease races, acknowledgement loss and final-attempt
crash/replay. Node tests use SQLite/libsql and stub the external Mosoo boundary;
they verify that POST intent is durable before the first external call. Actual
local workerd/D1 tests additionally cover source capabilities, raw-hash rejection,
supersession, and atomic run/receipt statement rollback. Neither suite is remote
Cloudflare staging, real Mosoo completion, Queue delivery or production recovery
evidence; those remain separate release gates.

In outbox mode the core finalizer never invokes the legacy Feed projection,
including a best-effort invocation after commit. Legacy projection,
reconciliation and tag-review writes reject before touching storage when the
source outbox or Go backend is enabled. Only the versioned executor/operator
writes that catalog. This process-level guard is not the database writer fencing
required for a later fact-source migration.

Artifact validation errors remain terminal. A failure to persist already valid
artifacts is different: the existing run remains `finalizing`, returns retryable
`analysis_persistence_unavailable` (503), and the existing reconciler retries that
same run and external thread. Finalizing runs are not expired by the earlier
evaluation execution deadline. Cache refresh failure cannot mark committed
results invalid. Service-level regression tests inject a real core outbox abort,
then recover the same artifacts exactly once; a failing or permanently stalled
legacy Feed function is never called in this mode. These tests use synthetic
external artifacts and are not evidence of a real paid evaluation.
