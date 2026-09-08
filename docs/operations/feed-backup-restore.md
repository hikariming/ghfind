# Feed snapshot validation and restore handoff

The tooling provides an **offline relational snapshot format and validator**, plus a bounded recovery drill using two newly created local workerd/D1 databases. It is not a production backup scheduler or promotion controller. `scripts/feed-snapshot.mjs` has no network client, database connection or arbitrary SQL interface. It builds a new local artifact from an already exported file and verifies that artifact independently. The separate `feed-snapshot-local.mjs` fixture exercises actual local D1 export/import and later deletion replay; it does not certify a live production export, physical object recovery, RPO or RTO.

## Registered source and scope

Two explicit `cf_d1_r2` registries are accepted, both with runtime contract 1:

| Migration set | Registry       | Physical tables / columns | Runtime control value |
| ------------- | -------------- | ------------------------- | --------------------- |
| 0001–0007     | `cf-d1-feed-7` | 43 / 321                  | 7                     |
| 0001–0009     | `cf-d1-feed-9` | 45 / 348                  | 7                     |

`scripts/feed-snapshot-schema.mjs` fixes every migration SHA-256, full table/column inventory, physical type, nullability, primary key, secondary unique key and enum. Schema 9 adds the governance command ledger and empty transaction guards; it also registers the partial unique index `status='active'`. Multiple retired taxonomy versions remain valid. The immutable schema-7 fingerprint is `20a7df78a1d0cbf746460c39b4506dbe8f31c8a8352d310d5b23a678c74e2301`; schema 9 has its own fingerprint and row-hash namespace.

`metadata.source.schemaVersion` explicitly selects the reviewed migration set. Schema 9 records `runtimeControlSchemaVersion:7` in its registry because migrations 0008 and 0009 do not modify `feed_runtime_control.schema_version`. The validator requires the actual value 7; changing it to 9 to match a filename rejects. A control value of 7 alone cannot identify which migration set was installed. Metadata, registry fingerprint and complete table/column descriptors must agree.

PostgreSQL schema 19, standalone D1 schema 8 and every unknown schema/contract are rejected. No registry is inferred from a directory scan, environment variable, incoming extra field or an untrusted SQL definition. Existing schema-7 manifests and per-row hashes remain byte compatible.

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

Registered timestamp columns also use integer Unix milliseconds. The admission range is explicitly 2000-01-01 through 9999-12-31 UTC; a seconds-valued timestamp or a historical sentinel outside this range requires an explicit format extension or repair, not automatic conversion. Durations, counters and versions are distinct integer fields. A row's `source_version` cannot exceed the ending core source watermark.

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
node scripts/feed-snapshot.mjs schema 9
node scripts/feed-snapshot.mjs schema 7
node scripts/feed-snapshot.mjs build --metadata reviewed-metadata.json --input export.ndjson --out new-snapshot-directory
node scripts/feed-snapshot.mjs validate --dir new-snapshot-directory --expected-manifest-sha256 TRUSTED_MANIFEST_SHA256
node --test scripts/feed-snapshot.test.mjs
```

For an independent worktree awaiting the schema commits, the schema test and local drill may set `FEED_SNAPSHOT_SCHEMA_ROOT` to the reviewed checkout containing those migrations and adapter source. This is a read-only source-code location; it is never a database or persistence path. Missing files and changed migration hashes fail; they are not skipped. Normal integrated CI should use the current checkout without this override.

The `schema` command defaults to 9; `schema 7` returns the retained registry. Build and validation always select from explicit metadata, independently of that display default. Library callers emitting per-row hashes must pass the version to `rowRecord(table, row, 9)` for schema 9; the omitted third argument retains the original schema-7 behavior.

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

The current drill uses schema 9: it verifies all nine registered migration hashes, installs those statements in real local D1, and compares `PRAGMA table_info`, primary keys, complete/partial unique keys and physical types to the registry. Restoration includes all 348 physical columns without coercion or default substitution. This is an independent schema-9 run, not a reinterpretation of the earlier schema-7 report. SQLite/D1 internal tables and migration bookkeeping are outside the business snapshot. The actual `foreign_key_list` determines insertion order; constraints remain enabled. Installation seeds are removed only from the newly allocated target; the singleton writer control remains closed throughout restoration. A deliberately failing two-row import batch verifies that D1 rolls back the first insert when the second conflicts.

The source fixture compiles the checked-out adapter and uses its real business commands for users, explicit preferences, served requests, events, saved state, sessions and deletion. Four synthetic actors are used: 101 survives, 303 is deleted before backup, 202 is deleted after backup, and 404 retains the older stored taxonomy version. A synthetic project/provenance receipt admits one candidate without contacting GitHub or pretending this is real OAuth or assessment evidence. Export enumerates every registered table under the local writer fence; each table has a 1,000-row fixture limit. Canonical NDJSON is built and independently validated, read back from the artifact and imported in batches of at most 20 rows. Every actual business key, complete row, state/version and row hash is compared, and the re-exported whole-file hash must match. Foreign-key and quick-integrity checks must pass.

Before creating the three behavioral actors, actor 404 accepts an explicit preference under taxonomy 1. The fixture then calls the real protected governance proposal/review/command endpoints using a separate, randomly generated local operator secret. Its single synthetic review creates a canonical tag and advances the active taxonomy to 2; the command ledger records the actor, reason, payload hash and receipt. Actor 404 physically retains taxonomy 1 and an unchanged profile version, while an actual adapter read returns active taxonomy 2 and the retained taxonomy-1 preference. The other actors use taxonomy 2 for their requests and sessions, so deletion failures cannot be explained merely by a stale taxonomy.

After restoration, the command endpoint must return the exact original governance receipt. Retrying that identical command while the target writer gate remains closed must return the same receipt and change no rows; a full database comparison verifies this. The active taxonomy, canonical assignment, ledger and lazily read user state are all restored before the deletion replay.

The later deletion uses the source adapter's actual `profile.delete` transaction. Its resulting floor, deletion record, cleanup job and delete outbox row are independently captured in `post-snapshot-deletion.json`, bound to the backup manifest hash and given both row and whole-payload hashes. The target verifies and applies those facts while closed, removes the same immediately invalidated user-visible state as the source deletion command, and must then equal the entire post-deletion source database by every row. Repeating the overlay must leave identical rows. This is a bounded one-actor fixture; it is not a general deletion journal exporter or completeness proof for a live system.

Only the fresh local target is briefly reopened to test application behavior. Both previously deleted actors must have no old user/session, reject stale preference writes and old-request event replay, and receive a profile generation above the preserved floor on `users.ensure`. Their new candidate results must not read old impressions while physical cleanup is pending. The surviving actor's profile and session must still work; actor 404 must still expose the same lazily resolved taxonomy state. The target is closed again at the end. No route or primary is promoted.

Successful runs emit the auto-created artifact directory and write `evidence.json` only after all assertions pass. That report records migration hashes, actual source/target IDs, adapter bundle hash, counts, file/manifest hashes, deletion-overlay hash and visibility results. The Git SHA describes the checkout; the bundle hash identifies the exact compiled working-tree contents. Failures leave `failure.json` and their isolated diagnostic artifacts without a successful report. Each request has a 15-second deadline, CLI execution has a 180-second deadline, and the integration test fails rather than falling back to a mock or skipping unavailable workerd/D1. Test-created successful directories are cleaned; an explicit CLI run retains its own synthetic evidence directory for review.

The installed Miniflare 5 prerelease can start workerd but its Node `getD1Database` proxy was observed to stall. This harness calls its fixed loopback Worker using standard HTTP; D1 operations run inside workerd. This follows the actual D1 binding execution model rather than substituting a SQLite client. See [Cloudflare's local D1 testing documentation](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/).

The R2 binding is empty and local, used only to satisfy adapter health dependencies. **R2 object bytes, archive recovery, physical deletion completion, queue recovery, real OAuth, production availability and RPO/RTO are excluded.** Older event/request rows legitimately remain pending physical cleanup; generation and read fences must prevent them from becoming active behavior again. `cleanupCompleted:false` and `promotionReady:false` remain explicit in this drill's report. A quick synthetic execution time is not a recovered-service RTO.

## Required production and cross-profile restore work

1. Produce a source export using a verified consistent read or an approved bounded write fence, with external source inventory evidence and complete Feed change-log coverage. Preserve the core source facts separately; the core watermark alone is insufficient for preferences, events or deletions.
2. Store the relational artifact and its independently pinned manifest hash in the approved encrypted/archive environment. Export required R2 object bytes with registry key, object checksum, generation and retention/deletion evidence. Verify transferred bytes independently.
3. Create an isolated empty target through the protected release workflow. An importer must use its own strict table/column commands and keep the target write gate closed even if the source snapshot's `writes_enabled` was 1. Do not import a live routing epoch as permission to serve writes.
4. Validate the snapshot before import; apply control/deletion facts first under the isolated fence, import the registered rows without relaxing constraints, and overlay newer deletion logs before replaying tasks or restoring archive visibility. Old leased jobs need an explicit recovery policy; this offline tool does not run them or clear leases.
5. Replay complete increments through the final watermark, compare business keys, state, versions, deletion floors and object checksums, then run no-side-effect shadow reads and application E2E. A count-only comparison is insufficient. A D1→PostgreSQL→D1 drill also requires a separately tested physical-to-portable mapper; renaming table prefixes is not a migration.
6. Record actual RPO ≤15 minutes and RTO ≤60 minutes from the recovered application and data. Promotion requires the later writer-fence/epoch protocol and one release owner; timeout before promotion resumes the original primary. Once the new primary accepts writes, returning to the old primary requires reverse replay and another fence.

The format tests cover all-table encode/validate/rebuild equality, SQLite schema introspection, numeric/composite key ordering, duplicate business-key rejection, null/type/JSON/time validation, lost marker/control rejection, truncation/corruption detection and no-overwrite behavior. The separate local D1 drill provides actual isolated database export/import and application-level deletion-fence evidence when its emitted report says `passed`. Neither constitutes live production backup, archive transfer, external alert delivery, a complete application recovery, RPO measurement or promotion.
