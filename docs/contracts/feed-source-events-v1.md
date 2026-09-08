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
or assessment eligibility.

Claims are indexed, at most 100, with a 60-second lease and maximum ten attempts.
Retry delay doubles to a five-minute ceiling. Publication completion checks the
lease token and expiry. Losing acknowledgement may redeliver the same event;
execution must be idempotent and durable before queue acknowledgement. A worker
lost on attempt ten becomes a persisted failed record after lease expiry.
Operator replay retains identity and source version and records its reason,
count and timestamp. No unbounded automatic replay or catalog scan is used.

Local source-seam tests cover transaction rollback, explicit reuse, downstream
unavailability, deduplication, lease races, acknowledgement loss and final-attempt
crash/replay. They use SQLite/libsql as supplemental tests; real D1 execution,
queue delivery, executor restart and DLQ evidence are separate required gates.
