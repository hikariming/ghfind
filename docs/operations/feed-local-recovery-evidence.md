# Local D1 recovery evidence — 2026-09-08

The current schema-9 run below independently verifies actual local D1 export/import and governance/deletion behavior. The earlier schema-7 run is retained separately as historical evidence; its result does not stand in for schema 9. Both use synthetic facts and fresh isolated databases. Neither is production recovery, R2 object restoration, real OAuth or RPO/RTO acceptance. See [feed-backup-restore.md](feed-backup-restore.md) for the procedure and remaining gates.

## Current schema 9 execution

The current combined suite passed **18 tests, zero failures and zero skips**, including both pinned schema registries, schema-7 fingerprint compatibility, schema-9 governance/control corruption, actual D1 export/import and post-snapshot deletion visibility. The local D1 integration test took 2.13 seconds in that combined run; this small fixture duration is not an RTO or production SLO.

```sh
FEED_SNAPSHOT_SCHEMA_ROOT=/Users/asperformias/Code/github/ghfind node --test scripts/feed-snapshot.test.mjs scripts/feed-snapshot-local.test.mjs
```

A separately retained passing execution started at **2026-09-08T05:03:37.547Z**, used Node **v22.17.0** and Miniflare **5.20260907.0-alpha**, and completed its assertions in **1,888 ms**. It compiled adapter checkout `95f3eb338967d3c7f206210fb3d6c63c5abb01b5`; the bundle hash identifies the actual working-tree source. The complete registered migration set 0001–0009 covered **45 tables, 348 physical columns and 73 exported rows**. Migration hashes 0008=`9a544d9915f480562a0e87731ab72135b70492618692eeb444fb20c1a2aec6c1` and 0009=`4ed9ad89d6b752d70725e70f1004a935cbdbab799f85e0c6d60e15cedb84ac84` were checked before execution. `metadata.source.schemaVersion` was 9; the actual runtime control stayed 7, as those two migrations require.

| Evidence                               | Value                                                              |
| -------------------------------------- | ------------------------------------------------------------------ |
| Local source D1 identifier             | `5d91bb3a-39a2-4979-8320-ee149a5e2497`                             |
| Separate local target D1 identifier    | `a08e84ae-c917-42e8-8124-5093b4e83d92`                             |
| Compiled Worker bundle SHA-256         | `b427c21b6667cea2dd9c459c86adc5eec1eaafddceaa0bbe08bdbe3905841658` |
| Backup manifest SHA-256                | `c7effc128287912650b834c33529d634c145c618f6f9e81dd018270ed76517f9` |
| Backup and restored NDJSON SHA-256     | `304c502e57e8dd7242598941263a34118f1f4c7b97bc6a3e5773fc93e2d608fd` |
| Post-snapshot deletion overlay SHA-256 | `90da72bc3fbb30b8f2d8b5d1d6118e049c83bbcdac9087331d9a6d2e48bd9858` |
| Overlaid target NDJSON SHA-256         | `d654aed1d7c85f3a8e99b49211d0e2ed3c2e437fa9189d681e4abe79df5a1bfa` |
| Restored governance ledger row SHA-256 | `1c9e755f39fb7c7c0e071d71faf505e3332db17e23a4eaa939b1f04afeacd5eb` |

Retained synthetic artifacts: `/var/folders/tp/xrswdd4j6d34rzrjf66wnc980000gn/T/ghfind-local-d1-recovery-pMXmPr/evidence.json`. This is a local session path, not a durable archive. Fresh runs allocate new paths/identities and produce new hashes.

The source executed a real governance `create` command `5e471ebb-09ff-4824-9acd-945d2bce149a` through the adapter's protected endpoint with an independently generated local operator secret. It created `use_case:local-recovery-governed`, advanced active taxonomy from 1 to 2, preserved the old version as retired, and committed one ledger row with operator/reason, payload hash and receipt. After import, both the command query and an exact retry while the target write gate stayed closed returned the same receipt. Full-row comparison confirmed that the retry changed no facts.

Actor 404's stored user and preference taxonomy remained 1, its profile version did not change, and the real adapter returned active taxonomy 2 before and after restoration. The other actors' requests and sessions used taxonomy 2, avoiding a stale-taxonomy explanation for deletion rejections. This checks both governance facts and the intended lazy user-version behavior, without bulk-updating users to make the snapshot pass.

The target matched every table, primary/composite key, column, version, state, row hash and full-file hash. Actual D1 foreign-key and quick-integrity checks passed; the deliberate conflicting two-row restore rolled back. The later actual deletion of actor 202 was separately captured and applied before target reads; the entire target then matched the post-deletion source. Duplicate deletion overlay was inert, and applying it after a newer generation existed was rejected. Both deleted actors preserved floor 3, re-entered as generation 4 with no preferences and `seenAt:null`, rejected old sessions/events, and could not use stale preference state. Actor 101's original profile/session remained available. The writer gate was closed at the end.

The current validator also re-read the retained **schema-7** backup with its original trusted manifest hash `3a6f32521e86eef46a2eb19068a0778fbc8334ffc5c532234c4366bdac8bbb95`, accepting all 43 tables/63 rows and unchanged NDJSON hash `d6b59068b774f60682c78742b00a21c50e9243c6478ecfe48ea017a9ce32fd46`. That is backward-compatibility evidence, independent of the new schema-9 run.

## Historical schema 7 execution

The following report records the schema-7 harness from implementation commit `9a4fb9a`; the current harness defaults to schema 9. Its original artifacts and findings remain valid only for their recorded schema/source versions.

### Historical verification

The combined command below passed all 14 tests, with zero failures and zero skips. The real D1 integration test took 1.87 seconds in that run; elapsed time for this small local fixture is not an availability or recovery SLO.

```sh
FEED_SNAPSHOT_SCHEMA_ROOT=/Users/asperformias/Code/github/ghfind node --test scripts/feed-snapshot.test.mjs scripts/feed-snapshot-local.test.mjs
```

The override was required because the independent implementation worktree intentionally did not integrate shared migration/adapter commits. The integrated repository runs the same command without the override. Test inputs were checked-in migration bytes and the real adapter source; no remote database, access token or existing persistence directory was accepted.

The retained successful execution started at **2026-09-08T04:26:00.732Z**, used Node **v22.17.0**, Miniflare **5.20260907.0-alpha**, and completed its assertions in **1,805 ms**. It compiled adapter checkout `a982a9868eda6be758ddca37a271d11819f6483d`; the bundle hash below identifies the exact compiled working-tree source. The actual registry check covered **43 tables and 321 columns**. The fixture exported **63 rows**, including users, explicit/behavior preferences, served requests/items, events, saved state, sessions, controls and an existing deletion floor/job/outbox. Zero-row tables remained explicitly present in the inventory.

| Evidence                               | Value                                                              |
| -------------------------------------- | ------------------------------------------------------------------ |
| Local source D1 identifier             | `02547837-55e9-4bc6-864a-685ae5f0a940`                             |
| Separate local target D1 identifier    | `ff7a4ccf-999b-4f38-a6e9-d131ed10134e`                             |
| Compiled local Worker bundle SHA-256   | `643ccf33c9d543473c8d5a9e69ef04e1524fcfcd39e9b2218b35be8ac3ee615f` |
| Backup manifest SHA-256                | `3a6f32521e86eef46a2eb19068a0778fbc8334ffc5c532234c4366bdac8bbb95` |
| Backup and restored NDJSON SHA-256     | `d6b59068b774f60682c78742b00a21c50e9243c6478ecfe48ea017a9ce32fd46` |
| Post-snapshot deletion overlay SHA-256 | `20eed2f9b075487f4f6e1ecc2dfffdd496ddf118b1b840b8eaf3f44d4849692d` |
| Overlaid target NDJSON SHA-256         | `220aa2de8ad21238b409981d958b2f7f146bf12293fc5884b3fd525dd54547be` |

Machine-readable evidence and all relational artifacts were retained at `/var/folders/tp/xrswdd4j6d34rzrjf66wnc980000gn/T/ghfind-local-d1-recovery-RnGErO/evidence.json`. This path is a local session artifact, not a durable archive location. Re-running produces a new directory, synthetic identifiers, timestamps and hashes. There is no resume or reuse operation.

Every table's independent D1 count was checked before/after export. The fresh target matched every actual primary key, column, state, version and row hash, and the complete NDJSON hash matched the source backup. D1 foreign-key and quick-integrity checks passed. A deliberately conflicting two-row import batch rolled back its first insert; subsequent full-row comparison confirmed no partial import.

Actor 303 was deleted before backup; actor 202 was deleted by the actual source `profile.delete` command after the complete backup. The latter's real floor, deletion status, cleanup job and deletion outbox were captured separately and applied before exposing the target. The overlaid target equaled the complete post-deletion source by all rows. Duplicate overlay application changed no rows; attempting the old overlay after a newer local identity existed was rejected. The target writer gate was closed throughout import and again at the end of the read-behavior test.

For both deleted actors, the retained floor was 3 and the fresh profile generation was 4. Old sessions returned 404, stale preference writes returned 409, and old-request event replay returned 404. Fresh preferences were empty and fresh candidate `seenAt` was null. Actor 101's original profile and session remained usable. This verifies immediate read/generation fencing while physical event/request cleanup is still pending.

### Defect found by the historical drill

Before the new-generation impression assertion was added, row/hash restoration already succeeded. The stronger application check then failed: a new profile generation saw `seenAt: "2026-09-08T04:15:34.720Z"` from the deleted generation. The old candidate query read `feed_events` by actor and project without checking the request generation against the deletion floor.

The failed run wrote only failure evidence under `/var/folders/tp/xrswdd4j6d34rzrjf66wnc980000gn/T/ghfind-local-d1-recovery-UpTcj7/failure.json`; it did not issue a passed recovery report. The adapter fix was committed independently as `ec3c6a5` and integrated as `ce4d61f`: impression recall now requires matching request ownership and a request profile above the preserved floor. The full local recovery test passed after integration. The harness retains that regression assertion so pending physical cleanup cannot silently reintroduce the behavior.

## Remaining boundaries

The historical run covered only the first seven migration hashes. The current run separately verifies the explicit nine-migration registry and governance restoration. No unknown schema is accepted, and neither run proves a live schema upgrade, cross-profile mapper or production migration promotion.

R2 object bytes and their transfer/erasure were excluded; the empty local R2 binding only satisfied adapter dependencies. Cleanup requests remained pending, explicitly `cleanupCompleted:false`. Core assessment facts, queue transport, archive recovery, complete incremental Feed journals, real OAuth, production capacity, measured RPO/RTO and database promotion remain outside this drill. The output explicitly retains `promotionReady:false` and the snapshot format's conservative safety flags. No Cloudflare or other remote resource was created, queried, changed or deleted by the drill.
