# Interrupted production assessment recovery

The 2026-09-14 production attempt `34803862012/2` passed native off-mode,
baseline and explicit stop/start verification for all three fixed Go actors.
Its next gate failed on logical assessment
`ae16bdc6-a82c-484e-a197-33291206d85f`: the application had expired it before
reading the provider, and authenticated Mosoo inspection independently showed
`runtime.turn_interrupted` after 69.4 seconds. No completed artifacts were
observed. These are separate failures; neither is proof of a successful evaluation.

## Recovery boundary

The original assessment, source SHA, submission intent and failed provider
identity are pinned in the carryover and operator manifests. The protected
reconciliation endpoint verifies that exact provider failure before claiming a
single retry. It preserves the old timestamps, idempotency key, provider IDs and
failure in an atomic core-database audit. Only the new provider attempt receives
a new, persistent 30-minute execution deadline. Repeated operator requests use
the same request ID and provider idempotency key. They do not create another
logical assessment. A superseding assessment prevents stale recovery results
from replacing the current assessment.

`PROJECT_ANALYSIS_RECONCILE_SECRET` is an independent GitHub Production secret.
Actions installs it on the Web Worker; it never enters the Web build environment
or evidence artifacts. Recovery retains the ordinary artifact validation and
atomic assessment/source-outbox finalization. No source result or Feed projection
is inserted by the release script.

The production workflow first finishes native baseline verification, then
recovers the historical assessment journal, invokes the pinned operator action,
and records the database-anchored observation window. The complete old journal
and its canonical JSON SHA-256 remain nested in the new journal. A repeat run
cannot replenish the new window or polling counters. The original public POST
is never repeated. Public polling, source/queue projection checks and bounded
service smoke remain required before admitting Feed traffic.

## Validation and rollout

Before push, execute the full local dual-profile E2E with the exact clean commit.
Its external provider fixture includes interrupted-attempt recovery through the
real application, core D1, outbox and Go executor. Fixtures are not evidence of
real Mosoo execution. PR and main CI must separately validate their actual
checkout; only the main workflow may perform the production operation. Verify
Cloudflare versions, native identities and the real provider/source/projection
receipts after deployment.

The new core migration is additive. Do not remove the recovery audit, reset
`started_at`, remove the writer fence, or restore the legacy Next Feed writer.
Before admission the Web stays Go-only paused. After a failed admission the
workflow restores its verified compatible Go-only paused Worker. A completed
assessment and its outbox remain facts even if application rollout fails.

This closes the interrupted-assessment release path, not the separate capacity,
full cross-database migration, RPO/RTO or semantic-recall acceptance items.
