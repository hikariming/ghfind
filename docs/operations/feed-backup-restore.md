# Feed snapshot validation and restore handoff

The tooling provides an **offline relational snapshot format and validator**, plus a bounded recovery drill using two newly created local workerd/D1 databases. It is not a production backup scheduler or promotion controller. `scripts/feed-snapshot.mjs` has no network client, database connection or arbitrary SQL interface. It builds a new local artifact from an already exported file and verifies that artifact independently. The separate `feed-snapshot-local.mjs` fixture exercises actual local D1 export/import and later deletion replay; it does not certify a live production export, physical object recovery, RPO or RTO.

## Registered source and scope

Four explicit `cf_d1_r2` registries are accepted. HTTP/read contract stays 1; storage writer compatibility is versioned separately:

| Migration set | Registry        | Physical tables / columns | Runtime control | Storage writer contract |
| ------------- | --------------- | ------------------------- | --------------- | ----------------------- |
| 0001–0007     | `cf-d1-feed-7`  | 43 / 321                  | 7               | 1                       |
| 0001–0009     | `cf-d1-feed-9`  | 45 / 348                  | 7               | 1                       |
| 0001–0010     | `cf-d1-feed-10` | 45 / 350                  | 7               | 1                       |
| 0001–0011     | `cf-d1-feed-11` | 45 / 350                  | 7               | 2                       |

`scripts/feed-snapshot-schema.mjs` fixes every migration SHA-256, full table/column inventory, physical type, nullability, primary key, secondary unique key and enum. Schema 9 adds the governance command ledger and empty transaction guards; it also registers the partial unique index `status='active'`. Multiple retired taxonomy versions remain valid. The immutable schema-7 fingerprint is `20a7df78a1d0cbf746460c39b4506dbe8f31c8a8352d310d5b23a678c74e2301`; schema 9 has its own fingerprint and row-hash namespace.

`metadata.source.schemaVersion` explicitly selects the reviewed migration set. Schemas 9, 10 and 11 record `runtimeControlSchemaVersion:7`; these migration sets do not advance `feed_runtime_control.schema_version`. The validator requires the actual value 7; changing it to a migration number to match a filename rejects. A control value of 7 alone cannot identify which migration set was installed. Metadata, registry fingerprint and complete table/column descriptors must agree.

PostgreSQL schema 19, standalone D1 schema 8 and every unknown schema/contract are rejected. No registry is inferred from a directory scan, environment variable, incoming extra field or an untrusted SQL definition. Existing schema-7, schema-9 and schema-10 manifests and per-row hashes remain byte compatible. Schema 11 adds `writerContractVersion:2`; compatibility validation checks `registry.writerContractVersion ?? 1` instead of confusing the HTTP contract with the storage writer. Accepting an older artifact format does not make an older writer safe against schema 11. Promotion must still use a compatible writer and apply the reviewed migration sequence.

Schema 10 removes the user-proposal natural unique key and adds assignment origin and author-guard columns. Schema 11 changes no physical table/column, but pins the revised quarantine view and minimum writer semantics. Its fixed migration hash is `158add96337489e14af5193b8c06c3e1c0649395f2ea7ddbf1ea32b1b9ddc095`, and its registry fingerprint is `e78ddb0ae7b07462f9a3dc595132f8c2182236c900336e612181f681c9304f34`.

Every registered table must appear in the inventory and manifest even when it has zero rows. Transaction guard tables, including `feed_projection_commands`, must be empty at a committed read boundary. The control, schema compatibility and cleanup-policy tables must each contain their singleton. One active taxonomy is required. Primary keys are non-null even where legacy SQLite `TEXT PRIMARY KEY` would technically permit a null value; an exporter must surface such invalid identities for repair instead of assigning replacements.

This covers relational catalog, governance, user state, events, sessions, source references, task/replay state, archive registry, operator audit, deletion floors and cleanup records. It excludes R2 object bytes, Vectorize vectors, the core assessment database/outbox, secrets, GitHub OAuth session material and legacy Railway resources. The old Railway backup failure remains a separate unresolved operational fact; these files do not repair that job.

## Input and output contract

The `build` input consists of newline-delimited canonical JSON records:

```text
{"row":{...all registered physical columns including explicit nulls...},"table":"feed_users"}
```

This is an illustrative shape; the complete column list is returned by `schema`. Unknown tables, unknown columns and missing columns fail. JSON stored in SQLite TEXT remains a string and must parse as valid JSON; arrays, objects, scalar values and JSON null are permitted because SQLite `json_valid` permits them. Nullable SQL columns use JSON null; no value is silently defaulted or coerced. Integers must be JavaScript-safe integers; finite floating-point values are allowed only in registered REAL columns. Numeric identities serialized as strings are rejected.

Both the metadata file and NDJSON use UTF-8 canonical JSON, with exactly one final newline and no blank lines, BOM or CRLF. The exported `canonical(value)` function defines this format: recursively sort object keys by JavaScript UTF-16 code units and use JSON string/number serialization, disallowing negative zero and nonfinite numbers. The input spelling must match those canonical bytes, which also rejects duplicate object keys rather than accepting the last value silently. This is a local versioned encoding rule; it does not claim a general-purpose cross-language canonicalization standard.

Records are sorted first by table name using that deterministic text order, then by the table's actual composite primary key. Numeric key components compare **numerically**, so user 2 precedes user 10. Text key components use UTF-16 code units, never `localeCompare` or an unspecified database collation. An exporter must produce this order. Duplicate or decreasing primary keys reject in constant memory; secondary unique constraints use bounded sets for the current table and preserve SQLite's nullable-unique behavior.

Metadata has exactly these fields:

| Field                  | Required meaning                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshotId`           | UUID retained across the artifact's records and release evidence                                                                         |
| `source`               | Exact `profile`, `schemaVersion`, `contractVersion`, positive `writerEpoch`, 40-character `gitSHA` and source database `resourceId` UUID |
| `watermarks`           | `stream: "core_feed_outbox_sequence"`, nonnegative decimal-string `start` and `end`, with start ≤ end and signed-64-bit range            |
| `startedAt`, `endedAt` | Export interval, integer Unix milliseconds, start ≤ end                                                                                  |
| `timeUnit`             | Exactly `unix_ms`                                                                                                                        |
| `inventory`            | Every registered table mapped to its independently captured expected row count; missing or extra table names reject                      |

Registered timestamp columns also use integer Unix milliseconds. The admission range is explicitly 2000-01-01 through 9999-12-31 UTC; a seconds-valued timestamp or a historical sentinel outside this range requires an explicit format extension or repair, not automatic conversion. Schema 11 explicitly admits one sentinel: `feed_tag_proposal_commands.created_at=0` only together with `proposal_id=""` and `payload_hash="deleted"`. A partial tombstone rejects, and this exception does not permit zero timestamps in other columns or older registries. Durations, counters and versions are distinct integer fields. A row's `source_version` cannot exceed the ending core source watermark.

The source watermark describes **core assessment events only**. It is not a complete Feed user-state change journal. The inventory is an exporter assertion which this tool reconciles against the file; it cannot independently prove that the exporter included every source row or used one transactional read. Those claims require separately retained live-export evidence and the complete change log before any migration promotion.

The output directory contains:

| File            | Content                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rows.ndjson`   | Canonical records containing `table`, ordered `key`, original typed `row`, and per-row SHA-256                                                                          |
| `manifest.json` | Format/schema fingerprints, exact metadata, required safety declarations, all table descriptors with counts and hashes, total count, byte length and whole-file SHA-256 |

A row hash covers canonical `{schema,table,key,row}`. A table hash covers its exact output NDJSON lines, including newlines. The file hash covers all exact file bytes, independent of row or table hashes. The builder reports a separate manifest-file SHA-256 for a trusted release record. Hashes detect corruption and inconsistency; they are not signatures and cannot authenticate an attacker-controlled manifest plus data pair.

## Commands and filesystem behavior

Node.js 22 is sufficient for the production-format tool. The schema test additionally uses Python 3's standard SQLite module, creates only an in-memory database and reads checked-in migration files; no database server is contacted.

```sh
node scripts/feed-snapshot.mjs schema 11
node scripts/feed-snapshot.mjs schema 10
node scripts/feed-snapshot.mjs schema 9
node scripts/feed-snapshot.mjs schema 7
node scripts/feed-snapshot.mjs build --metadata reviewed-metadata.json --input export.ndjson --out new-snapshot-directory
node scripts/feed-snapshot.mjs validate --dir new-snapshot-directory --expected-manifest-sha256 TRUSTED_MANIFEST_SHA256
node --test scripts/feed-snapshot.test.mjs
```

For an independent worktree awaiting the schema commits, the schema test and local drill may set `FEED_SNAPSHOT_SCHEMA_ROOT` to the reviewed checkout containing those migrations and adapter source. This is a read-only source-code location; it is never a database or persistence path. Missing files and changed migration hashes fail; they are not skipped. Normal integrated CI should use the current checkout without this override.

The `schema` command defaults to 11; explicit `schema 7`, `schema 9` and `schema 10` return the retained registries. Build and validation always select from explicit metadata, independently of that display default. Library callers emitting per-row hashes must pass the version to `rowRecord(table, row, 11)` for schema 11; the omitted third argument retains the original schema-7 behavior.

Generate input with `canonical(record) + "\n"`; do not concatenate unescaped SQL output or client JSON. The build destination must not already exist. The tool creates it with mode 0700 and files with mode 0600, writes `rows.partial`, verifies all records/counts/deletion facts, then writes and renames the completion manifest. An interrupted or failed build leaves diagnostic partial files and no accepted manifest. It never overwrites, resumes, deletes or replaces an existing snapshot. Retain or remove that incomplete local artifact deliberately before choosing a new destination. Treat all snapshot files as sensitive behavior data despite credential exclusion.

The validator always checks every known table, exact column/primary-key descriptors, required safety declarations, controls, deletion-fence relationships, per-row hashes, counts, per-table hashes and whole-file bytes. An optional or forged `complete` field cannot bypass this: unknown manifest fields reject. Pin the reported manifest hash in an independently trusted release record and pass that value when validating a transferred artifact.

Bounds are fixed in the format implementation: 8 MiB per NDJSON line, 10 GiB per file, five million rows, 1 MiB metadata/manifest, 200,000 secondary unique keys per index in the active table and 100,000 deletion actors. Row payload processing is streaming; key ordering avoids an in-memory set of all event primary keys. These are admission bounds, not measured throughput or memory-SLO results. Increase them only with a reviewed change and a capacity test.

## Deletion and recovery boundary

Snapshots preserve every explicit deletion floor and cleanup/archive marker. A deletion or cleanup job without an equal-or-higher user floor rejects; completed deletion states require all cleanup flags, and erased archive objects require their erasure and marker-retention timestamps. Omitting a marker column or declaring a marker table absent cannot produce a valid artifact. A source inventory/hash mismatch also rejects missing rows. No file-only validator can discover a floor that an untrusted exporter removed from both data and all accompanying source assertions.

**A valid old snapshot alone cannot prevent resurrection.** A recovery process must first obtain the durable deletion log accumulated after the snapshot, including requests accepted during the outage, and apply its maximum user floors and archive erasure markers to the isolated target before old sessions, events, jobs or objects become usable. Preserve deletion markers for the full replay and backup window. Missing post-snapshot deletion evidence blocks promotion; it is never interpreted as “no deletions.”

Every accepted result explicitly retains `archiveObjectPayloadsIncluded:false`, `sourceCompletenessProven:false`, `consistentSourceReadProven:false`, `postSnapshotDeletionReplayRequired:true`, and `promotionReady:false`. The validator rejects altered safety claims rather than trusting a manifest flag to convert integrity validation into restore acceptance.

## Reproducible local D1 restore drill

Install the existing isolated packages, then run:

```sh
pnpm -C platform/runtime install --frozen-lockfile
pnpm -C platform/feed install --frozen-lockfile
node scripts/feed-snapshot-local.mjs plan
node scripts/feed-snapshot-local.mjs run
node --test scripts/feed-snapshot.test.mjs scripts/feed-snapshot-local.test.mjs
```

Only `plan` and `run` are accepted. There is no URL, resource ID, `--remote`, existing database path, output-directory override, resume or production mode. `run` allocates a new mode-0700 temporary directory, independent random D1 identifiers and separate source/target persistence directories. Its generated Worker listens only on `127.0.0.1`, requires a new random local token, disables telemetry/CF metadata fetching, and rejects external Worker requests. No credentials from the environment or Wrangler login are used. The local harness must never be deployed; it is a test fixture with fixed migration, export and restoration commands, and accepts no caller-provided SQL.

The current drill uses schema 11: it verifies all eleven registered migration hashes, installs those statements in real local D1, and compares `PRAGMA table_info`, primary keys, complete/partial unique keys and physical types to the registry. Restoration includes all 350 physical columns without coercion or default substitution. This independently tests schema 11 with storage writer 2 and runtime control 7; historical schema-7/9 reports are not reused as schema-11 evidence. The pinned SQL parser accepts the reviewed CTE, table/view and update statements in this migration set only after their exact file hashes match. It exposes no caller-supplied SQL interface. SQLite/D1 internal tables and migration bookkeeping are outside the business snapshot. The actual `foreign_key_list` determines insertion order; constraints remain enabled. Installation seeds are removed only from the newly allocated target; the singleton writer control remains closed throughout restoration. A deliberately failing two-row import batch verifies that D1 rolls back the first insert when the second conflicts.

The source fixture compiles the checked-out adapter and uses its real business commands for users, explicit preferences, served requests, events, saved state, sessions and deletion. Four synthetic actors are used: 101 survives, 303 is deleted before backup, 202 is deleted after backup, and 404 retains the older stored taxonomy version. A synthetic project/provenance receipt admits one candidate without contacting GitHub or pretending this is real OAuth or assessment evidence. Export enumerates every registered table under the local writer fence; each table has a 1,000-row fixture limit. Canonical NDJSON is built and independently validated, read back from the artifact and imported in batches of at most 20 rows. Every actual business key, complete row, state/version and row hash is compared, and the re-exported whole-file hash must match. Foreign-key and quick-integrity checks must pass.

Before creating behavioral requests/sessions, actor 404 accepts an explicit preference under taxonomy 1. The fixture calls protected governance endpoints with an independent random operator secret. An assessment review creates a canonical tag and advances taxonomy to 2. Actor 202 then creates a pending and a separately reviewed user proposal; the latter maps to an existing canonical tag, advances taxonomy to 3 and records its controlled `governance:<commandId>` evidence reference and `origin_proposal_id`. Both raw user bodies, authors, command receipts, two governance ledger rows and the canonical assignment are in the backup. Actor 404 physically retains taxonomy 1 and an unchanged profile version while reads return taxonomy 3. Actors 101/202/303 create their requests and sessions only after taxonomy 3 is active, so later session rejection cannot be credited to a stale taxonomy.

Actor 303 also creates a proposal before its pre-backup deletion. Actual bounded cleanup runs against the source's empty local R2 binding before export, leaving a real minimal proposal-command tombstone in the backup. All rows, including `created_at=0` with the full tombstone sentinel, are restored without coercion. The assignment and ledger remain independently reviewed public/audit facts; raw user evidence is not approved automatically.

After restoration, the governance command query and exact retry must return the original receipt. Full-row comparison confirms no mutation while the target write gate remains closed. The restored active taxonomy, ownership, assignment references, prior tombstone and lazy user state are verified before later deletion replay.

The later deletion uses the source adapter's actual `profile.delete` transaction. Its resulting floor, deletion record, cleanup job and delete outbox row are independently captured in `post-snapshot-deletion.json`, bound to the backup manifest hash and given both row and whole-payload hashes. The target verifies and applies those facts while closed, removes the same immediately invalidated user-visible state as the source deletion command, and must then equal the entire post-deletion source database by every row. Repeating the overlay must leave identical rows. This is a bounded one-actor fixture; it is not a general deletion journal exporter or completeness proof for a live system.

Only the fresh local target is briefly reopened to test application behavior. Both previously deleted actors must have no old user/session, reject stale preference writes and old-request event replay, and receive a profile generation above the preserved floor on `users.ensure`. Their new candidate results must not read old impressions while physical cleanup is pending. The surviving actor's profile and session must still work; actor 404 must still expose the same lazily resolved taxonomy state. Before physical cleanup, both actor-202 proposals must inspect as null and fresh reviews must reject with `governance_proposal_deleted`. An exact existing governance review still returns its safe receipt; a full-row comparison proves it cannot rewrite evidence or assignments. The new profile cannot reuse an old proposal command. A newly created generation-4 proposal survives cleanup of generation 3.

Cleanup uses the real executor-authenticated `claim/step/release` endpoints: each invocation has at most eight steps, each step handles at most 100 rows, and at most six invocations are allowed per fixture phase. The source's prior deletion and the target's later deletion each finish in two invocations for this fixture. Assertions require erased raw slug/labels/evidence, blanked proposal-command links/hashes/timestamps, removed old author rows, retained independent canonical weight/confidence and a cleared assignment evidence field. The original governance receipt cannot restore erased bodies on retry. A historical proposal without an author remains invisible and its retained body remains counted by the fixed quarantine view. It is not automatically attributed or erased to make the report pass. The target is closed again at the end. No route or primary is promoted.

Successful runs emit the auto-created artifact directory and write `evidence.json` only after all assertions pass. That report records migration hashes, actual source/target IDs, adapter bundle hash, counts, file/manifest hashes, deletion-overlay hash and visibility results. The Git SHA describes the checkout; the bundle hash identifies the exact compiled working-tree contents. Failures leave `failure.json` and their isolated diagnostic artifacts without a successful report. Each request has a 15-second deadline, CLI execution has a 180-second deadline, and the integration test fails rather than falling back to a mock or skipping unavailable workerd/D1. Test-created successful directories are cleaned; an explicit CLI run retains its own synthetic evidence directory for review.

The installed Miniflare 5 prerelease can start workerd but its Node `getD1Database` proxy was observed to stall. This harness calls its fixed loopback Worker using standard HTTP; D1 operations run inside workerd. This follows the actual D1 binding execution model rather than substituting a SQLite client. See [Cloudflare's local D1 testing documentation](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/).

The R2 binding is empty and local. Primary erasure and cleanup across that empty bucket are exercised, with semantic cleanup explicitly disabled by policy. `postDeletion.cleanupCompleted:false` describes the immediate overlay checkpoint; the later `privacyRecovery.primaryCleanupCompleted` and `emptyLocalArchiveCleanupCompleted` describe the bounded local cleanup assertions. **Actual R2 object export/transfer/restore, queue recovery, real OAuth, production availability and RPO/RTO remain excluded.** No object-byte recovery evidence is inferred from an empty-bucket cleanup. `realR2ObjectRestoreVerified:false` and `promotionReady:false` remain explicit. The unowned retained body is itself an unresolved promotion gate. A quick synthetic execution time is not a recovered-service RTO.

## Required production and cross-profile restore work

1. Produce a source export using a verified consistent read or an approved bounded write fence, with external source inventory evidence and complete Feed change-log coverage. Preserve the core source facts separately; the core watermark alone is insufficient for preferences, events or deletions.
2. Store the relational artifact and its independently pinned manifest hash in the approved encrypted/archive environment. Export required R2 object bytes with registry key, object checksum, generation and retention/deletion evidence. Verify transferred bytes independently.
3. Create an isolated empty target through the protected release workflow. An importer must use its own strict table/column commands and keep the target write gate closed even if the source snapshot's `writes_enabled` was 1. Do not import a live routing epoch as permission to serve writes.
4. Validate the snapshot before import; apply control/deletion facts first under the isolated fence, import the registered rows without relaxing constraints, and overlay newer deletion logs before replaying tasks or restoring archive visibility. Old leased jobs need an explicit recovery policy; this offline tool does not run them or clear leases.
5. Replay complete increments through the final watermark, compare business keys, state, versions, deletion floors and object checksums, then run no-side-effect shadow reads and application E2E. A count-only comparison is insufficient. A D1→PostgreSQL→D1 drill also requires a separately tested physical-to-portable mapper; renaming table prefixes is not a migration.
6. Record actual RPO ≤15 minutes and RTO ≤60 minutes from the recovered application and data. Promotion requires the later writer-fence/epoch protocol and one release owner; timeout before promotion resumes the original primary. Once the new primary accepts writes, returning to the old primary requires reverse replay and another fence.

The format tests cover all-table encode/validate/rebuild equality, SQLite schema introspection, numeric/composite key ordering, duplicate business-key rejection, null/type/JSON/time validation, lost marker/control rejection, truncation/corruption detection and no-overwrite behavior. The separate local D1 drill provides actual isolated database export/import and application-level deletion-fence evidence when its emitted report says `passed`. Neither constitutes live production backup, archive transfer, external alert delivery, a complete application recovery, RPO measurement or promotion.
