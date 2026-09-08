# Feed snapshot validation and restore handoff

The delivered tooling is an **offline relational snapshot format and validator**, not a database backup scheduler, importer or promotion controller. `scripts/feed-snapshot.mjs` has no network client, database connection or arbitrary SQL interface. It builds a new local artifact from an already exported file and verifies that artifact independently. It does not certify a consistent live export, physical object recovery, RPO, RTO or deletion safety after the snapshot time.

## Registered source and scope

The only accepted registry is `cf-d1-feed-7`: storage profile `cf_d1_r2`, schema 7 and runtime contract 1. `scripts/feed-snapshot-schema.mjs` fixes all 43 tables, their 321 columns, SQLite primary keys including composite keys, secondary unique keys, nullability, JSON text and scalar types, enum constraints and the SHA-256 of each migration through `0007_feed_schema_compatibility.sql`. PostgreSQL schema 19 and D1 schema 8 are rejected until a reviewed registry or mapper is implemented. A schema change is never inferred from an environment variable, a file count or an incoming manifest's claims.

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

| Field | Required meaning |
| --- | --- |
| `snapshotId` | UUID retained across the artifact's records and release evidence |
| `source` | Exact `profile`, `schemaVersion`, `contractVersion`, positive `writerEpoch`, 40-character `gitSHA` and source database `resourceId` UUID |
| `watermarks` | `stream: "core_feed_outbox_sequence"`, nonnegative decimal-string `start` and `end`, with start ≤ end and signed-64-bit range |
| `startedAt`, `endedAt` | Export interval, integer Unix milliseconds, start ≤ end |
| `timeUnit` | Exactly `unix_ms` |
| `inventory` | Every registered table mapped to its independently captured expected row count; missing or extra table names reject |

Registered timestamp columns also use integer Unix milliseconds. The admission range is explicitly 2000-01-01 through 9999-12-31 UTC; a seconds-valued timestamp or a historical sentinel outside this range requires an explicit format extension or repair, not automatic conversion. Durations, counters and versions are distinct integer fields. A row's `source_version` cannot exceed the ending core source watermark.

The source watermark describes **core assessment events only**. It is not a complete Feed user-state change journal. The inventory is an exporter assertion which this tool reconciles against the file; it cannot independently prove that the exporter included every source row or used one transactional read. Those claims require separately retained live-export evidence and the complete change log before any migration promotion.

The output directory contains:

| File | Content |
| --- | --- |
| `rows.ndjson` | Canonical records containing `table`, ordered `key`, original typed `row`, and per-row SHA-256 |
| `manifest.json` | Format/schema fingerprints, exact metadata, required safety declarations, all table descriptors with counts and hashes, total count, byte length and whole-file SHA-256 |

A row hash covers canonical `{schema,table,key,row}`. A table hash covers its exact output NDJSON lines, including newlines. The file hash covers all exact file bytes, independent of row or table hashes. The builder reports a separate manifest-file SHA-256 for a trusted release record. Hashes detect corruption and inconsistency; they are not signatures and cannot authenticate an attacker-controlled manifest plus data pair.

## Commands and filesystem behavior

Node.js 22 is sufficient for the production-format tool. The schema test additionally uses Python 3's standard SQLite module, creates only an in-memory database and reads checked-in migration files; no database server is contacted.

```sh
node scripts/feed-snapshot.mjs schema
node scripts/feed-snapshot.mjs build --metadata reviewed-metadata.json --input export.ndjson --out new-snapshot-directory
node scripts/feed-snapshot.mjs validate --dir new-snapshot-directory --expected-manifest-sha256 TRUSTED_MANIFEST_SHA256
node --test scripts/feed-snapshot.test.mjs
```

For an independent worktree awaiting the schema commits, the **test only** may set `FEED_SNAPSHOT_SCHEMA_ROOT` to the reviewed checkout containing those migrations. Missing files and changed migration hashes fail the schema test; they are not skipped. Normal integrated CI should use the current checkout without this override.

Generate input with `canonical(record) + "\n"`; do not concatenate unescaped SQL output or client JSON. The build destination must not already exist. The tool creates it with mode 0700 and files with mode 0600, writes `rows.partial`, verifies all records/counts/deletion facts, then writes and renames the completion manifest. An interrupted or failed build leaves diagnostic partial files and no accepted manifest. It never overwrites, resumes, deletes or replaces an existing snapshot. Retain or remove that incomplete local artifact deliberately before choosing a new destination. Treat all snapshot files as sensitive behavior data despite credential exclusion.

The validator always checks every known table, exact column/primary-key descriptors, required safety declarations, controls, deletion-fence relationships, per-row hashes, counts, per-table hashes and whole-file bytes. An optional or forged `complete` field cannot bypass this: unknown manifest fields reject. Pin the reported manifest hash in an independently trusted release record and pass that value when validating a transferred artifact.

Bounds are fixed in the format implementation: 8 MiB per NDJSON line, 10 GiB per file, five million rows, 1 MiB metadata/manifest, 200,000 secondary unique keys per index in the active table and 100,000 deletion actors. Row payload processing is streaming; key ordering avoids an in-memory set of all event primary keys. These are admission bounds, not measured throughput or memory-SLO results. Increase them only with a reviewed change and a capacity test.

## Deletion and recovery boundary

Snapshots preserve every explicit deletion floor and cleanup/archive marker. A deletion or cleanup job without an equal-or-higher user floor rejects; completed deletion states require all cleanup flags, and erased archive objects require their erasure and marker-retention timestamps. Omitting a marker column or declaring a marker table absent cannot produce a valid artifact. A source inventory/hash mismatch also rejects missing rows. No file-only validator can discover a floor that an untrusted exporter removed from both data and all accompanying source assertions.

**A valid old snapshot alone cannot prevent resurrection.** A recovery process must first obtain the durable deletion log accumulated after the snapshot, including requests accepted during the outage, and apply its maximum user floors and archive erasure markers to the isolated target before old sessions, events, jobs or objects become usable. Preserve deletion markers for the full replay and backup window. Missing post-snapshot deletion evidence blocks promotion; it is never interpreted as “no deletions.”

Every accepted result explicitly retains `archiveObjectPayloadsIncluded:false`, `sourceCompletenessProven:false`, `consistentSourceReadProven:false`, `postSnapshotDeletionReplayRequired:true`, and `promotionReady:false`. The validator rejects altered safety claims rather than trusting a manifest flag to convert integrity validation into restore acceptance.

## Required next-stage restore drill

1. Produce a source export using a verified consistent read or an approved bounded write fence, with external source inventory evidence and complete Feed change-log coverage. Preserve the core source facts separately; the core watermark alone is insufficient for preferences, events or deletions.
2. Store the relational artifact and its independently pinned manifest hash in the approved encrypted/archive environment. Export required R2 object bytes with registry key, object checksum, generation and retention/deletion evidence. Verify transferred bytes independently.
3. Create an isolated empty target through the protected release workflow. An importer must use its own strict table/column commands and keep the target write gate closed even if the source snapshot's `writes_enabled` was 1. Do not import a live routing epoch as permission to serve writes.
4. Validate the snapshot before import; apply control/deletion facts first under the isolated fence, import the registered rows without relaxing constraints, and overlay newer deletion logs before replaying tasks or restoring archive visibility. Old leased jobs need an explicit recovery policy; this offline tool does not run them or clear leases.
5. Replay complete increments through the final watermark, compare business keys, state, versions, deletion floors and object checksums, then run no-side-effect shadow reads and application E2E. A count-only comparison is insufficient. A D1→PostgreSQL→D1 drill also requires a separately tested physical-to-portable mapper; renaming table prefixes is not a migration.
6. Record actual RPO ≤15 minutes and RTO ≤60 minutes from the recovered application and data. Promotion requires the later writer-fence/epoch protocol and one release owner; timeout before promotion resumes the original primary. Once the new primary accepts writes, returning to the old primary requires reverse replay and another fence.

The current evidence consists of synthetic all-table encode/validate/rebuild equality, SQLite schema introspection, numeric/composite key ordering, duplicate business-key rejection, null/type/JSON/time validation, lost marker/control rejection, truncation/corruption detection and no-overwrite tests. There has been no live export/import, archive transfer, restoration of a database, alert delivery, application recovery, RPO measurement or promotion in this delivery.
