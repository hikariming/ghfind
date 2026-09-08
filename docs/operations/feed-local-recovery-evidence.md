# Local D1 recovery evidence — 2026-09-08

Scope: the schema-7 relational recovery fixture in `scripts/feed-snapshot-local.mjs`, using two fresh local workerd/D1 databases. This is actual database export/import and application-read evidence with synthetic data. It is not production recovery, R2 object restoration, OAuth evidence or RPO/RTO acceptance. The reproducible procedure and remaining gates are in [feed-backup-restore.md](feed-backup-restore.md).

## Verified execution

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

## Defect found by the drill

Before the new-generation impression assertion was added, row/hash restoration already succeeded. The stronger application check then failed: a new profile generation saw `seenAt: "2026-09-08T04:15:34.720Z"` from the deleted generation. The old candidate query read `feed_events` by actor and project without checking the request generation against the deletion floor.

The failed run wrote only failure evidence under `/var/folders/tp/xrswdd4j6d34rzrjf66wnc980000gn/T/ghfind-local-d1-recovery-UpTcj7/failure.json`; it did not issue a passed recovery report. The adapter fix was committed independently as `ec3c6a5` and integrated as `ce4d61f`: impression recall now requires matching request ownership and a request profile above the preserved floor. The full local recovery test passed after integration. The harness retains that regression assertion so pending physical cleanup cannot silently reintroduce the behavior.

## Remaining boundaries

All seven migration hashes, schema controls and deletion floors were preserved. Schema 8's additional indexes and schema 9's ongoing governance tables are not silently included: a later reviewed registry extension must verify exact migration bytes, actual columns/keys/types, control semantics and fresh/upgrade restoration before advertising compatibility.

R2 object bytes and their transfer/erasure were excluded; the empty local R2 binding only satisfied adapter dependencies. Cleanup requests remained pending, explicitly `cleanupCompleted:false`. Core assessment facts, queue transport, archive recovery, complete incremental Feed journals, real OAuth, production capacity, measured RPO/RTO and database promotion remain outside this drill. The output explicitly retains `promotionReady:false` and the snapshot format's conservative safety flags. No Cloudflare or other remote resource was created, queried, changed or deleted by the drill.
