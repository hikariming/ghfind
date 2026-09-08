# Local D1 recovery evidence — 2026-09-08

The current schema-11 run independently verifies actual local D1 export/import, proposal privacy, deletion overlay and bounded cleanup against an empty local R2 binding. Earlier schema-7/9 evidence is retained separately; neither historical result is used to claim schema-11 acceptance. All runs use synthetic facts and fresh isolated databases. Actual R2 object recovery, real OAuth and production RPO/RTO remain outside this evidence. See [feed-backup-restore.md](feed-backup-restore.md) for the procedure and gates.

## Current schema 11 execution

The complete suite passed **24 tests, zero failures and zero skips** in 2.88 seconds. It checked the fixed physical registries for schemas 7, 9, 10 and 11, retained older fingerprints, schema-10/11 artifact round trips, writer-compatibility rejection, strict minimal tombstones, and real local D1 restoration/deletion behavior.

```sh
FEED_SNAPSHOT_SCHEMA_ROOT=/Users/asperformias/Code/github/ghfind node --test scripts/feed-snapshot.test.mjs scripts/feed-snapshot-local.test.mjs
```

A separately retained passing run started at **2026-09-08T05:43:18.732Z** and completed its assertions in **2,683 ms**. It compiled adapter checkout `7f660f2c9978bec460fdec01e3dd64fd7dd067e3` and verified all eleven fixed migration hashes. The actual restored inventory contained **45 tables, 350 physical columns and 76 rows**, including pending and reviewed user proposals, authors, assignment origin/reference, two governance ledger entries and a command tombstone created by actual cleanup before backup. The registry uses `writerContractVersion:2`, HTTP/read contract 1 and actual runtime control 7. Migration 0011 hash is `158add96337489e14af5193b8c06c3e1c0649395f2ea7ddbf1ea32b1b9ddc095`; the schema-11 fingerprint is `e78ddb0ae7b07462f9a3dc595132f8c2182236c900336e612181f681c9304f34`.

| Evidence                            | Value                                                              |
| ----------------------------------- | ------------------------------------------------------------------ |
| Local source D1 identifier          | `c18dfb46-c24a-498c-ac75-9064ca3676b9`                             |
| Separate local target D1 identifier | `092ecf07-cd1e-499f-a4c5-12f1eac769a4`                             |
| Compiled Worker bundle SHA-256      | `f46f08c7759a12118c55b287ce7e6a6c567bc8def054f9a92bb4ec4e94b440cc` |
| Backup manifest SHA-256             | `4058ea62e88edf28803ef07caf943115544db365c569f9646bcdf461443e444c` |
| Backup and restored NDJSON SHA-256  | `2d61bbab7d1facb42a840f3e85b99e239966df512780b1f5b2af29a990d9138d` |
| Later deletion overlay SHA-256      | `ebd1ea1858e3824efff7a140b36800300814d5014ca1321161eb5ca85ff4d73f` |
| Overlaid target NDJSON SHA-256      | `6efb69984a7924ba6eb6ef1e15098823ee17db2af8cdd9a4bd4bdac6d7df77e6` |

Retained synthetic artifacts: `/var/folders/tp/xrswdd4j6d34rzrjf66wnc980000gn/T/ghfind-local-d1-recovery-Io8XeJ/evidence.json`. The path belongs to this local session and is not a durable backup destination. Fresh runs generate new identities, timestamps and hashes.

The source first reviewed an assessment proposal, moving taxonomy 1→2, then independently reviewed actor 202's user proposal, moving taxonomy 2→3. Its other user proposal remained pending. Only after both reviews did actors 101/202/303 create taxonomy-3 requests and sessions. Actor 404 remained physically at user/preference taxonomy 1, with an unchanged profile version, and read active taxonomy 3. Thus deletion rejections are checked independently of taxonomy invalidation. Full-row comparisons verified restored facts, the whole-file hash and inert exact governance retries; the deliberate conflicting import batch rolled back and actual D1 integrity/foreign-key checks passed.

Actor 303's real pre-backup deletion ran two bounded cleanup invocations (11 steps) on the source. The backup therefore contained its erased proposal and a genuine minimal command tombstone, including the intentional zero timestamp. Schema 11 admits zero only for `feed_tag_proposal_commands.created_at` with both `proposal_id=""` and `payload_hash="deleted"`; incomplete sentinels and zero timestamps elsewhere reject. Historical schema 7/9/10 row encoding is unchanged.

After the backup completed, the source accepted actor 202's deletion. Its floor/job/status/outbox were independently captured, hash-bound to the backup and overlaid before target reads. Every target row matched the post-deletion source; duplicate replay was inert. Both the pending and reviewed proposals then inspected as null, new reviews returned `governance_proposal_deleted` (409), and the old exact governance review returned only its safe receipt without rewriting any row. Old sessions/events could not cross floor 3 into generation 4; new preferences were empty and `seenAt` was null. Actor 101's original session remained usable.

The target then ran two bounded cleanup invocations (11 steps, 15 affected rows) for actor 202. Raw slug, labels and evidence were erased; both user command rows retained only tombstones with no proposal link, payload hash or timestamp; both old author rows disappeared. The independently reviewed canonical assignment, weight and confidence remained, while its user evidence was cleared. A new generation-4 proposal and its author survived. Retrying the prior command still could not restore the old body.

The quarantine view finally counted **4 unowned proposals, of which 1 still retained a historical body**; the other three were erased tombstones. The retained body was not assigned an author or silently discarded. It remains a promotion blocker, and `promotionReady:false` is asserted. Primary cleanup and empty-local-R2 cleanup passed; **actual R2 object transfer/restore was not tested**. `postDeletion.cleanupCompleted:false` records the immediate overlay checkpoint, while the later `privacyRecovery` section records local cleanup completion. Neither field certifies production restoration, object-byte recovery or an RPO/RTO target.

## Historical schema 9 execution

That schema-9 combined suite passed **18 tests, zero failures and zero skips**, including both pinned schema registries, schema-7 fingerprint compatibility, schema-9 governance/control corruption, actual D1 export/import and post-snapshot deletion visibility. The local D1 integration test took 2.13 seconds in that combined run; this small fixture duration is not an RTO or production SLO.

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

That validator also re-read the retained **schema-7** backup with its original trusted manifest hash `3a6f32521e86eef46a2eb19068a0778fbc8334ffc5c532234c4366bdac8bbb95`, accepting all 43 tables/63 rows and unchanged NDJSON hash `d6b59068b774f60682c78742b00a21c50e9243c6478ecfe48ea017a9ce32fd46`. That is backward-compatibility evidence, independent of the new schema-9 run.

## Historical schema 7 execution

The following report records the schema-7 harness from implementation commit `9a4fb9a`; the current harness defaults to schema 11. Its original artifacts and findings remain valid only for their recorded schema/source versions.

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

The current run verifies only its explicit schema-11 registry and writer-2 behavior. Historical schema-7/9 reports retain their original sources and scope; schema 10 has format/schema validation, not a separately claimed production restoration. No unknown schema is accepted. These results do not prove a live schema upgrade, cross-profile mapper or database promotion.

The current run exercises primary erasure and actual cleanup against an empty local R2 bucket. The historical runs left physical cleanup pending. No run transfers or restores actual R2 object bytes. Core assessment facts, queue transport, a complete incremental Feed journal, real OAuth, production capacity, measured RPO/RTO and promotion remain outside this drill. The current quarantine retained-body count is a further unresolved promotion gate. No Cloudflare or other remote resource was created, queried, changed or deleted by these fixtures.
