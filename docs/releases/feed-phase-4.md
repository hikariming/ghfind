# Feed stage 4 source and recovery handoff

Base: `b47b2ee4ab94fb2f833a3d613886ea41524c03bd`, the merged standalone runtime
foundation (#248). Storage job/checkpoint/replay capabilities came with #246;
the private source adapter, queues and executor dispatch came with #248. This
PR connects the existing assessment commit to those capabilities and adds a
strict snapshot format and real isolated D1 restore drill.

The source seam defaults off. `FEED_SOURCE_OUTBOX_ENABLED=true` requires the
reviewed core migrations 0005/0006, which remain outside the production
application migration allowlist. Explicit app submission creates its receipt
with the source run before an external thread is created. Completed-run reuse
records current user intent; background reconciliation does not manufacture
historical provenance. Assessment facts, completion and outbox share one core
transaction. No queue or Feed database participates in that transaction.

In outbox mode the finalizer does not call the legacy Feed writer at all. Legacy
catalog projection, reconciliation and tag-review operations fail closed before
storage access when the outbox or Go backend is enabled. Valid artifacts whose
core transaction fails keep their original run/thread in `finalizing` and return
retryable 503; a subsequent reconciliation retries persistence rather than the
evaluation. Invalid artifact identity remains terminal. Neither the earlier
execution deadline nor cache refresh failure changes that distinction.

Commit boundaries: atomic source/receipt/outbox seam; immutable snapshot format
and validation; actual local D1 export/restore with post-backup deletion overlay;
source failure-isolation regression; CI and handoff. The legacy deployment
manifest and live runtime flags are unchanged. No production schema application,
record deletion, Queue execution or backup promotion is performed by this PR.

## Verification and remaining gates

Local TypeScript/lint and 743 application tests passed before this handoff.
The 14 snapshot tests passed against actual local workerd/D1 and SQLite registry
introspection, including transaction failure, every key/column/version/hash,
post-backup deletion overlay and old-generation read rejection. The service test
first reproduced invalid failure classification and a permanently blocking old
Feed call, then verified retry and zero legacy invocations after the fix.

The checked-in machine report identifies a schema-7 migration set, 43 tables,
321 columns and 63 synthetic rows. It does not validate later governance tables.
A separate schema-9 registry/drill is being prepared with explicit support for
the older schema-7 artifact format. Keep this PR draft until that integration
and its own exact-head CI pass. R2 object transfer, full change journals,
D1/PostgreSQL round-trip promotion and measured RPO/RTO remain open.

Stage 5 must combine the runtime and governance changes with this source seam,
then collect real CF Queue failure/replay, full archive/deletion recovery, real
OAuth/evaluation and controlled release evidence. A local hash-equal restoration
is not a promotable backup: artifacts explicitly retain `promotionReady:false`.
The old Railway backup failure is unresolved by these local results.

Rollback keeps the same fact source and a compatible implementation. Do not
reverse destructive SQL, promote this synthetic fixture, flip profiles after new
writes, or re-enable the unfenced legacy projector during a database migration.
The actual resource IDs and remaining credential/protection gaps are recorded
in `docs/audits/2026-09-08-feed-staging-resources.md`; this handoff contains no keys.
