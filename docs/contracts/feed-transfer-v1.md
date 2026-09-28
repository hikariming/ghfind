# Feed transfer v1: bounded journal preparation contract

Status: offline protocol preparation only, based on `1bc35c3`. This is **not a
complete change journal, a D1/PostgreSQL mapper, or permission to migrate**.
`internal/feedtransfer` neither connects to a database nor writes, captures,
replays, fences or promotes one. No business transaction, migration number,
routing configuration or production resource changes in this delivery.

**Known blocking limitation:** PostgreSQL `PostgresFeedStore.DeleteFeedProfile` deletes a user
inside its source transaction (`internal/backend/feed_store.go`), cascading to
preferences, requests, served items, events, sessions and other rows. A real
large actor can delete 250,000 events in that transaction. The user cleanup
command and `internal/backend/feed_maintenance.go` retention deletes can also
exceed v1 limits. Their complete write sets cannot fit this format. No capture
switch or production promotion may be connected to this v1 implementation until
a separate, reviewed contract handles those real operations. Increasing the
limit, omitting cascades or paging one source transaction is not a solution.
The next design must prove deletion and retention semantics, not merely accept a
smaller synthetic example.

## What is delivered

The package validates a closed interval of bounded, whole Feed transactions,
explicit source coverage, canonical hashes, monotonic deletion floors and
caller-persisted page receipts. It produces decisions and a next checkpoint;
**it does not execute those decisions**. Every successful result reports:

| Result | Meaning |
| --- | --- |
| `ProtocolComplete` | The supplied interval ends at its declared final commit. This is not evidence that capture included every real write. |
| `CaptureConnected = false` | No source transaction emits this journal yet. |
| `RowSchemaValidated = false` | Images have a safe transport shape, but column completeness, schema types, keys and ownership have not been checked. |
| `ArchiveBytesVerified = false` | Referenced object inventory and object bytes have not been read or verified. |
| `PromotionReady = false` | No control-plane evidence authorizes a database promotion. |

The existing core assessment outbox is a projection input. Its sequence, Feed
runtime/task outboxes, queue attempts and archive counters are **not** the
transaction sequence defined here. `stream` must literally be
`feed_transaction_journal`; an outbox stream identifier is rejected.

## Resource identity and manifest

Wire DTO field names are the exact lower-camel JSON tags in `types.go` and the
shared fixture `testdata/transfer-v1.json`. Every field is mandatory, including
empty arrays and explicit null actor/image fields. Unknown/misspelled fields,
duplicate keys (including escaped duplicates), null scalar fields, trailing JSON
and invalid UTF-8 are rejected. Isolated escaped UTF-16 surrogates are rejected
in keys and values before Go decoding; legal pairs are accepted. All integer
fields use literal base-10 integer JSON tokens and the range 0…9,007,199,254,740,991;
identity epochs, actor IDs, generations and commit sequences are positive.
Values such as `1.0` and `1e0` are not canonical integer DTO representations.

Each `Identity` contains:

| Field | Requirement |
| --- | --- |
| `profile` | `cf_d1_r2` or `postgres` |
| `resourceId` | Lowercase UUID, version 1–8 and RFC variant, registered to one immutable database resource by the deployment controller; never a DSN, hostname, credential or human environment label |
| `schema` | Exactly 11 for D1 or 22 for PostgreSQL in this registry |
| `writerContract` | Exactly 2, independent of HTTP/read contract 1 |
| `writerEpoch` | Expected epoch in that resource's own control record; source and target epochs need not have the same value |
| `routeEpoch` | Expected global routing generation, whose target value is exactly source + 1 |

Source and target must have different resource UUIDs. The same profile is
permitted for isolated restoration; the identity still distinguishes the two
databases. Deployment registry verification is not implemented by this package.
Source routing/writer control rows are staged, not executed to enable the target.
An unknown profile/schema/writer contract fails closed. A reverse migration is a
**new** manifest with identities reversed, a new migration ID, a newly verified
source journal and the next route epoch. Changing an environment variable is not
reverse replay.

A manifest binds version 1, stream, migration UUID, journal UUID, both identities,
full snapshot SHA-256, archive inventory SHA-256 and object count, deletion-floor
overlay hash and actor count, `fromSequence`, `throughSequence`, `anchorHash`, and
coverage. The snapshot includes the prefix through `fromSequence`; the journal
must contain every following commit up to `throughSequence`. A zero prefix uses
64 zeroes as its anchor; a nonzero prefix requires its real nonzero commit hash.
The source identity/schema/epochs stay fixed for that journal segment. A schema
or writer transition closes a segment and requires a fresh verified manifest.

Snapshot and object inventory hashes refer to externally verified immutable
artifacts. This package does not invent an archive inventory encoding or claim
the current D1 snapshot format can already map PostgreSQL. The future artifact
adapter must declare its own version, byte encoding and verification evidence.
The supplemental core outbox watermark remains in its source artifact; it cannot
be substituted for either Feed sequence field.

The deletion overlay is a sorted, unique `(githubId, profileFloor)` set containing
snapshot floors **and all newer verified deletion floors available before
replay**. Its hash and actor count are pinned in the manifest. `Begin` checks it,
and `ValidateBatch` independently checks it again whenever the checkpoint is at
`fromSequence`, so bypassing `Begin` cannot silently drop the initial overlay.
Its completeness and relation to the closed source watermark require external
source evidence. The current capacity bound is 100,000 distinct floor actors.

## Coverage means inventory, not mapping completeness

`RequiredRegistry` selects current D1 schema 12 / PostgreSQL schema 22.
`RegistryForSchema` separately retains D1 schema 11 for historical manifests and
unchanged v1/v2 fixture hashes; neither registry implements a target mapper.
Coverage must contain every registered physical relation exactly once, in ASCII
table-name order, with its exact mode/category and nonnegative snapshot row count.
Missing relations, duplicate entries, unknown relations, category changes and
unjustified ignore policies fail closed. This catches a declaration omission;
only source-side instrumentation and fault tests can prove actual capture.

| Category | Obligation |
| --- | --- |
| `fact` | Preserve the domain fact, privacy generation, provenance, governance and idempotency meaning through a schema-aware mapper. |
| `control` | Account for jobs, delivery/replay receipts, deletion and archive progress, rate limits and runtime controls; reconcile leases and authority explicitly. Never start target writers by copying source controls. |
| `derived` | Account for behavior signals and embeddings/model state. A later mapper may choose a documented rebuild, with deletion/version checks; this protocol grants no automatic omission. |
| `legacy` | Preserve or explicitly quarantine/archive older Gorse, algorithm configuration and projection maintenance data until ownership/disposition is proved. These are not asserted to be new Feed primary facts. |

D1 schema 11 has 45 physical tables in the existing snapshot registry. Eight
transaction guard tables have `mode=empty`: archive, command, delivery,
execution, operator, projection-command, proposal and governance guards. Their
snapshot count must be zero and journal changes to them are forbidden: temporary
guards must never survive a committed business transaction. All other schema-11 relations have `mode=capture`.

D1 schema 12 adds two derived runtime controls: `feed_adapter_write_context` has
`mode=empty` and a zero snapshot count; `feed_adapter_write_fence` has
`mode=reinitialize` and exactly one source inventory row. Journal mutations to
either table are rejected in both v1 and v2. A future schema-aware adapter must
initialize the target fence to `{id:1,enabled:1}` and verify the context is empty;
it must never replay a source marker or enable legacy writes. These are explicit
reinitialization obligations, not an implemented mapper or promotion receipt.

PostgreSQL schema 22 has a different inventory. It includes source-aware tags,
proposals, user generations, deletion/cleanup state and older derived/legacy
relations. Equal table counts would not establish a mapping; this package makes
no such claim. Future adapters must produce a reviewed per-relation mapping or
disposition matrix for **both** directions, including runtime control and archive
representations. SQL migration ledgers, SQLite internal metadata and views are
not business row streams: schema identity and migration verification cover them.
Core assessment facts, OAuth/session facts outside Feed and source outbox tables
belong to separate resources and are outside this Feed database transfer.

The unit inventory check installs all 12 D1 SQL files in local SQLite and compares
physical table names; it is not a Workers transaction test. PostgreSQL inventory
is checked against all 22 SQL declaration files, not by pretending that SQLite
runs PostgreSQL migrations. Existing mandatory database suites remain necessary.

## Transaction, change and page limits

A sequence represents **one committed atomic source write set**, not one row or
one task. Sequence values are consecutive. `transactionId` is exactly
`journalId + ":" + sequence` with canonical decimal sequence; it cannot be reused
under another sequence. Each transaction names its previous commit hash and all
ordered changes. It must fit wholly in one page. The source must persist its
write set and sequence atomically with the business transaction, or capture a
proven equivalent database commit stream. Neither mechanism is implemented here.

| Bound | v1 value |
| --- | --- |
| Manifest input | 256 KiB |
| Batch serialized input | 8 MiB, enforced by a streaming read cap |
| Transactions per batch | 32 |
| Changes per transaction | 512 |
| Total changes per batch | 2,048 |
| One image / total image bytes in a transaction | 2 MiB |
| Canonical mapper key | 1,024 UTF-8 bytes, no C0/DEL control characters |
| JSON nesting / nodes | 32 / 200,000 |

The transport caller must enforce its own total deadline; a bounded reader
cannot impose a deadline on an arbitrary stalled `io.Reader`.

A change has a registered `table`, opaque canonical mapper `key`, `operation`,
explicit nullable `actor` and explicit nullable `image`. No SQL or arbitrary
predicate is accepted. Actor scope is `{githubId, profileVersion}`. It is required
for actor-private relations and user deletion/archive control rows. Shared
relations reject actor metadata. Mixed legacy/outbox/proposal relations require
a later schema-aware mapper to prove whether actor scope is required for that
specific row. A metadata claim is not proof that the image belongs to the actor.

The image is standard base64 of the **exact** UTF-8 bytes of a nonempty flat JSON
object of SQL column names to values. Values may be null, text, boolean or a
canonical safe integer; fractions/SQL numeric values are lossless decimal
**strings**. SQL JSON/JSONB is represented as a text cell, not a nested decoded
object. Timestamp and binary column encoding must be fixed by the schema mapper
(e.g. explicit UTC precision / base64); this module does not guess them or convert
seconds to milliseconds. The schema mapper must check every column, type,
identity, key, source version and nullable field before any target write.
Images are hashed exactly, without reserializing, Unicode normalization, float
formatting, timestamp conversion or sorting their column keys. A different byte
representation is a different image and cannot silently replace a receipt.

The source capture order is immutable once hashed. Duplicate row keys within a
transaction are rejected; one explicit `floor` metadata change may accompany a
row after-image for that same tombstone row. Capture collapses intermediate
updates into the complete final write set and preserves commit order. Unknown
operations and attempted guard-table mutations fail closed.

## Hash transcript, shared across runtimes

SHA-256 output is lowercase hexadecimal. A token `s` contributes ASCII decimal
`len(UTF8(s))`, then `:`, then those exact bytes; there is no trailing delimiter.
Integers contribute their canonical decimal string, booleans `1` or `0`. Arrays
contribute their length first. Object field names are not transcript tokens;
fixed field order below provides their meaning. Domain tags are framed tokens.

1. **Identity:** profile, resourceId, schema, writerContract, writerEpoch,
   routeEpoch.
2. **Floors:** domain `ghfind.feed.transfer.floors.v1`, actor count, then each
   githubId and profileFloor sorted by numeric githubId.
3. **Manifest:** domain `ghfind.feed.transfer.manifest.v1`, version, stream,
   migrationId, journalId, source identity, target identity, snapshotSha256,
   archiveInventorySha256, archiveObjects, deletionFloorsSha256,
   deletionFloorActors, fromSequence, throughSequence, anchorHash, coverage count,
   then each table, mode, category, snapshotRows in registry order.
4. **Transaction:** domain `ghfind.feed.transfer.transaction.v1`, source identity,
   journalId, sequence, transactionId, previousHash, change count, then each
   table, key, operation, actor-present boolean, optional githubId/profileVersion,
   decoded image byte length and SHA-256 of those bytes. A null image uses length
   zero and SHA-256 of empty bytes. The transaction's own hash is excluded.
5. **Batch:** domain `ghfind.feed.transfer.batch.v1`, version, manifestHash,
   afterSequence, previousHash, transaction count, each transaction hash in order,
   final boolean. The batch's own hash is excluded.

The journal hash is source-specific and does not depend on a target migration.
The manifest and batch bind the target as well, preventing page interchange
between migrations. These are integrity checks, **not signatures**; storage and
operator authorization must authenticate artifacts, manifest and checkpoint.

`testdata/transfer-v1.json` contains synthetic Chinese text, HTML characters,
U+2028, a valid escaped surrogate pair, null, actor recreation and deleted-command
tombstones across two pages. The independent Python implementation
`testdata/generate_fixture.py` checks the exact hashes. `unicode-v1.json` includes
portable accepted/rejected Unicode inputs. Future TypeScript capture and target
mapper implementations must run the same fixture, rather than minting a separate
"equivalent" hash convention.

## Legal deletion replay

Before considering any upsert in a transaction, the validator merges **all** its
floor changes into the current floor map by maximum. This prevents row order
inside one transaction from reviving old data. Snapshot floors, later overlay
floors and transaction floors never decrease.

| Operation | Constraint and decision |
| --- | --- |
| `upsert` | Requires an image. Actor content at generation ≤ effective floor becomes `suppress_deleted_generation`. New generations remain eligible for schema mapping. Runtime writer/schema controls become `stage_control` and cannot activate the target. |
| `delete` | Requires null image. The mapper must delete exactly that scoped identity, never a newer generation sharing a natural key. Deleting a floor row is forbidden. |
| `floor` | Only D1 `feed_profile_floors` or PG `feed.user_deletion_tombstones`, with actor and null image. `retain_max_floor` preserves the maximum. |
| `erase` | Only user proposal tables, with actor, null image and generation ≤ floor. The mapper clears private proposal slug/labels/evidence without erasing independently reviewed public classification. Mixed PG proposal source/author must be verified. |
| `command_tombstone` | Only user proposal command tables, actor and null image, generation ≤ floor. The mapper retains the minimum actor+command+generation replay fence, replaces payload hash with `deleted`, removes proposal linkage and resets original creation time. No body or prior payload hash is present. |

An upsert of a floor/tombstone control row requires a matching `floor` record for
that table/key/actor in the same transaction; the decision is
`merge_floor_control`. The future mapper must preserve the maximum while mapping
remaining cleanup progress, never replacing it with an older after-image.
Deletion/cleanup/archive control rows need their schema-specific safe progress
mapping even below the floor; they cannot be suppressed like a preference and
thereby lose recovery. Unknown author proposals, shared project tag evidence,
prior governance receipts and controlled origin references also need the existing
privacy rules in the mapper. This envelope does not validate their inner columns.
A successful protocol check alone therefore cannot establish privacy-safe replay.

The declared operation set does **not** include actor-wide purge or arbitrary
range delete. It cannot compact the current large source cascades into an
unreviewed promise that the target will eventually delete the right rows.

## Checkpoints, duplicates and commit acknowledgement

`Begin(manifest, verifiedFloors)` creates the first checkpoint. `ValidateBatch`
requires the next page to match that checkpoint's sequence, commit hash and
manifest identity. It verifies each transaction hash and contiguous sequence,
then the page hash. A page is final exactly when its last sequence is
`throughSequence`. An empty page is permitted only to close an empty interval.
A missing page, reordered transaction, conflicting image, duplicate key,
unknown version, incomplete coverage or premature final marker fails closed.
No returned error contains actors, keys, image values or raw decoder text.

The caller must use a **trusted durable** checkpoint loaded from its target
ledger. After the initial overlay validation, the module cannot cryptographically
prove later checkpoint floors came from previous committed decisions. Artifact
hashes and caller-supplied receipts are not authentication. The apply adapter must
commit target mutations, the exact returned receipt, next commit hash, merged
floors and final flag atomically. If it internally commits one source transaction
at a time, it needs an additional durable per-transaction receipt protocol; it
cannot acknowledge the whole page after a partial commit. Neither ledger exists
in a database yet.

An exact duplicate page is accepted without decisions only when the caller
supplies its matching durable receipt and the durable checkpoint has already
committed that receipt's complete interval. A different digest at that receipt
boundary is a conflict. A receipt ahead of the checkpoint is rejected. Without
a receipt, an old/reordered page is rejected instead of assumed successful.
The caller must enforce unique receipt boundaries and prevent concurrent
checkpoint updates with CAS/locking. Lost acknowledgement may repeat a page;
it may never repeat its mutations.

Private images and archive inventories may contain user data. Keep transfer
artifacts encrypted/access-controlled and apply the existing deletion/retention
policy. Public logs may record only fixed error codes and approved aggregate
counts; no raw payload, key, actor, image hash or decoder exception. The included
fixtures are synthetic. This package does not add a public endpoint.

## Validation and next delivery gates

Local checks for this commit:

```sh
go test -race ./internal/feedtransfer
go vet ./internal/feedtransfer
python3 internal/feedtransfer/testdata/generate_fixture.py
```

The checks cover both source registries, real local SQLite physical inventory,
strict wire parsing and limits, unsafe numbers and Unicode, source/target epoch
identity, missing/conflicting/out-of-order pages, exact durable duplicate
handling, deletion overlay omission, same-transaction floor precedence,
recreated generations, image-free tombstones and source control staging.
They are not real D1/PG capture, mapper, recovery or cutover tests.

The next independent commit must resolve the known large deletion and retention
transaction representation with reviewed semantics and real database fixtures.
Only then can subsequent work instrument **every** authorized mutation path,
including cascades, atomic state/events/profile updates, governance, projector,
cleanup, delivery/replay, archive registration and relevant legacy writers. That
work needs crash/failure/concurrency proof that business success and journal
commit cannot separate. Source outbox coverage is insufficient.

After capture: implement both schema-aware mappers, object inventory/byte
verification and private-data erasure checks; persist target receipts/checkpoints
with writes; reconcile by business identity/state/version/deletion markers; prove
snapshot + replay consistency; complete shadow reads; then build the protected
writer fence, bounded drain and atomic route promotion controller. Reverse replay
must pass the same gates after the new target has accepted writes. Until those
independent stages pass, all capture activation and production promotion gates
remain open, regardless of a successful v1 protocol result.
