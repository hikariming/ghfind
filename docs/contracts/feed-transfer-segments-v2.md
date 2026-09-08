# Feed transfer v2: bounded segments of one source transaction

Status: **protocol preparation only**. This adds no source capture, durable
staging database, target mapper, database migration or production routing.
Version 1 files, wire bytes, hashes and validation behavior remain unchanged.
The v2 seal references the existing v1 resource/coverage manifest and its hash;
segment, transaction, progress and receipt transcripts use separate v2 domains.
A v1 transaction consumer must reject v2, not reinterpret its segments as commits.

This closes the **transport representation** gap for large source transactions.
It does not prove that the existing 250k-event PostgreSQL cascade is captured, or
that a D1 target can atomically apply its complete mapped write set. Both remain
mandatory gates. PostgreSQL retention can legally leave an event with a null
`request_id`; D1 schema 11 still cannot directly represent that value. No mapper
may silently substitute an empty string, invent a request or discard the event.

## Closed source transaction, bounded content

`TransactionSeal` declares one source commit: manifest identity, transaction ID
(`journalId:sequence`), previous commit hash, total changes/content bytes/segments,
last segment hash, floor-record count/chain, transaction hash and seal hash. It
must cover the complete committed write set, including cascades and `SET NULL`
after-images. Source capture must prove that claim independently; the protocol
cannot infer a missing source mutation from an internally consistent seal.

`TransactionSegment` identifies that seal and source transaction, its zero-based
index and first change ordinal, previous segment hash, changes and hash. Each
change wraps the existing v1 `Change` with a required nullable `beforeHash`:

- `delete`, `erase` and `command_tombstone` require the exact source row digest.
- `floor` is image-free metadata and requires `beforeHash=null`.
- `upsert` uses null for insertion or the prior source digest for replacement.

The future snapshot/capture mapper must retain source identity and digest,
normalized target identity/digest and actor incarnation so an old delete cannot
remove a new profile's row with the same natural key. Neither a caller-supplied
actor field nor a source digest alone proves target ownership. This protocol
validates the transport shape; it does not implement those schema-aware checks.

Every segment retains the v1 bounds: at most 512 changes, at most 2 MiB total image
bytes and at most 8 MiB wire bytes. The caller reserves a `SegmentQuota` before
receiving content. Its declared totals must fit these ceilings:

| Whole-transaction ceiling | Value |
| --- | --- |
| Changes | 1,000,000 |
| Content bytes | 256 MiB |
| Segments | 2,048 |

Content charge per change is the UTF-8 byte length of table + key + operation,
plus decoded image bytes, plus 16 when actor scope exists, plus 64 when
`beforeHash` exists. This fixed formula avoids JSON whitespace/base64 ambiguity;
separate wire, image and count bounds cover encoding/structural overhead. Empty
segments and impossible totals are rejected. A configured reservation can be
smaller, never larger. Exceeding it fails closed; no truncation, cascade omission
or partial business acknowledgement is allowed.

Changes are globally ordered by the tuple **(table UTF-8 bytes, key UTF-8 bytes,
operation UTF-8 bytes)**. There is no Unicode normalization, SQL locale collation,
or JavaScript default UTF-16 comparison. The implementation compares the same
components separated by NUL, which is forbidden inside keys and registry names.
U+E000 sorts before U+10000 by this rule; JavaScript's default sort reverses them.
The shared fixture places these keys in different segments.

Duplicate row identities are rejected using only the last ordering cursor.
The sole same-key exception is `floor` followed by its matched tombstone-row
`upsert`; both must remain in the **same segment**, preserving the existing v1
validation rule. Source capture must emit the sorted final write set, not every
intermediate rewrite of one row. Sorting/spooling the actual committed source
set remains a future adapter responsibility, not in-memory accumulation here.

## Hashes and complete passes

All transcripts use v1's domain-separated, decimal byte-length-prefixed UTF-8
tokens. Booleans are `1`/`0`; numbers are canonical decimal safe integers. Domain
tags, lists and field order are frozen by `segments_hash.go` and the independent
Python fixture generator. Important boundaries:

1. Segment hash binds source identity, journal ID, v2, transaction ID/sequence,
   previous commit hash, segment index/ordinal/previous hash and all ordered
   changes. Changes bind actor-presence and values, before-hash-presence/value,
   decoded image length and exact image-byte SHA-256.
2. It deliberately excludes `sealHash`: the seal itself includes the final
   segment hash. Including both would create a circular definition. On receipt,
   the segment envelope's seal hash must equal the validated target-bound seal.
3. Transaction hash binds source identity/journal, its entire commit boundary,
   total counts/bytes, final segment hash and floor-record chain. Seal hash binds
   version, manifest hash and transaction hash, therefore also the target.
4. Floor-chain entries bind previous floor-chain hash, table, key, githubId and
   profileVersion, in their actual global change order. The empty chain is 64
   zeroes. Intermediate staging needs only that hash and count, not all actors.
5. Stage-progress hash binds every progress field and last ordering cursor. A
   stage-receipt hash binds version, seal, segment identity, prior progress hash
   and next progress hash.
6. Decision hash binds seal hash, the fully merged floor-set hash, total changes,
   then each zero-based global ordinal and the v1 action name. This certifies the
   protocol decision stream, not a database mapper's execution.
7. Atomic receipt binds its exact prior checkpoint hash, stage-progress hash,
   transaction and floor-chain hashes, decision hash, approved map version,
   normalized result hash, unique atomic apply ID and resulting checkpoint hash.
   Checkpoint hashes include the full floor-set hash/count and final marker.

The floor pass and row pass have independently verified inputs:

- First, reread exactly the declared immutable staged floor records; validate
  their v1 shape, strict order, count and complete floor-chain hash. Merge every
  floor by maximum with the prior applied checkpoint. The existing separate
  bound of 100,000 distinct floor actors applies to this final merge.
- Then reread **all** staged segments from the beginning. Revalidate each row,
  segment hash, ordinal, global ordering, quota and entire chain/seal. Reject
  early EOF and extra data. Apply v1's protocol rules to the already merged full
  floor set: unfenced erase/tombstone fails, old-generation upserts are suppressed,
  writer controls are staged, and floor controls retain their merge semantics.
- Compute the decision digest without storing per-row decisions. The target
  mapper must make its own independently reviewed schema/ownership/FK checks and
  consume these same decisions from immutable content before real atomic apply.

`ValidateStagedSemantics` performs these read-only passes before a future mapper
attempt. `ProposeCheckpointAdvance` repeats them when validating the committed
receipt. There is no `pass=true` flag that can replace the records and chains.
A stalled reader still needs a caller-enforced deadline; counts and byte bounds
cannot impose a deadline on an arbitrary callback or `io.Reader`.

## Staged is not applied

`StageProgress` contains only constant-size counts, hashes, flags and the last
bounded ordering key. It never contains the accumulated transaction's JSON tree,
row list or mutation receipt. `ready=true` means all content matches the seal,
not that rows are applied or that deletion is complete.

`BeginStaging` validates resource/epoch/coverage identity, total quota and the
prior applied checkpoint, including the pinned initial deletion overlay.
`ValidateSegment` returns a **proposal** for new stage progress and a
`DurableStageReceipt`. The future caller must atomically persist immutable segment
bytes, receipt and new progress before acknowledging that segment. Until then,
the proposed receipt is not durable evidence. The module writes nothing.

After restart, load the latest authenticated receipt and use `RestoreStaging`.
Do not reconstruct progress from process memory, supplied counters, a queue ack,
or the mere existence of an object in R2. Lost staging acknowledgement can retry
the exact segment with its persisted receipt: it returns a duplicate without
advancing progress. A changed digest, receipt ahead of persisted progress, wrong
transaction, missing segment or unreceipted old segment fails closed. Concurrent
staging writers need a unique segment key and CAS on the prior progress hash.
These database constraints are a **caller contract**, not implemented storage.

The future apply adapter must wait for complete content and semantic verification,
then perform the complete mapped write set, maximum floors, receipt and applied
head update in **one target database transaction**. PostgreSQL can be evaluated
with its native transaction; D1 needs actual proof that its fixed capabilities can
atomically handle the complete mapped set within platform limits. Persisting
segments separately and later adding a commit marker is not atomic business
application. If that transaction cannot run, the target capability remains blocked.
Staging must remain private and cannot be connected to live business reads.

Only an authenticated `AtomicCommitReceipt` with `outcome="applied"` permits
`ProposeCheckpointAdvance` to propose the next applied checkpoint. The receipt
must match the entire seal, completed stage, approved map version, protocol
decision stream and exact merged floor set; it cannot drop a floor or add an
unproven one. Missing/accepted-only receipts fail. Images, actor incarnation,
nullable columns and normalized result correctness still require the mapper's
real transaction evidence. Integrity hashes are not signatures.

**Atomic commit acknowledgement loss has a separate path.** The target transaction
must also persist `AppliedHead{checkpoint, atomicReceiptHash}`. On restart after
commit, `ConfirmCommittedTransaction` compares that authenticated current head
with the exact stored receipt's resulting checkpoint and receipt hash. It returns
only duplicate confirmation of that current commit, without replay, requiring an
old in-memory checkpoint, or advancing anything. A changed receipt, rolled-back
head or other transaction is rejected. Historical receipts older than the current
head need a separately authenticated ledger-status capability; this method does
not infer ancestry from sequence numbers.

## Explicit evidence boundary

All staging results keep `CaptureConnected`, `DurableStorageVerified` and
`PromotionReady` false. Advance/duplicate results keep `CaptureConnected`,
`AtomicApplicationVerified`, `RowSchemaValidated` and `PromotionReady` false.
`AtomicReceiptMatched` means the trusted caller's supplied ledger record matches
the protocol; the package cannot inspect a real database commit. These APIs must
not be exposed as an endpoint that trusts client-asserted receipts.

The only final floor memory is the existing 100k-actor bounded merge. Every
segment/content pass retains at most one segment plus constant-size progress.
Plain errors contain fixed codes only. Transfer images, source hashes, before
hashes, last keys, floors and receipts are private recovery artifacts; never emit
them to public request logs. Use authenticated encrypted storage and the existing
deletion/retention policy. No journal object may resurrect deleted content during
restore, and a staging transport test cannot prove object erasure.

## Local acceptance and next commit

Tests generate 250,000 synthetic, image-free PostgreSQL event deletions through a
replayable chunk producer. They never build a 250k-element slice or JSON tree.
There are 489 segments of at most 512 changes; each is serialized, decoded,
validated and restarted from a serialized modeled receipt. The largest progress
record measured in the fixture is 506 bytes. The test checks no retained
transaction-sized heap and no applied-checkpoint advancement; it is not a D1/PG
benchmark or real persistence test.

Additional regressions cover missing/reordered/foreign segments, duplicate and
changed receipts, total quotas and seal tampering, global UTF-8 order, same-key
floor pairing, invalid erasure without a floor, exact merged floors, changed
suppression digest, independent row-pass completeness, atomic lost-ack recovery,
and atomic receipt restart with the full 100,000-floor quota. Only the atomic
receipt decoder has a 400k JSON-node bound for that legitimate payload; its body
remains 8 MiB. Other decoders and all v1 limits remain unchanged.

`testdata/segments-v2.json` and `generate_segments_fixture.py` independently freeze
segment, seal, staging, decision and atomic-receipt hashes. The included atomic
receipt is explicitly synthetic, not evidence of a database apply.

```sh
go test -race ./internal/feedtransfer
go vet ./internal/feedtransfer
python3 internal/feedtransfer/testdata/generate_fixture.py
python3 internal/feedtransfer/testdata/generate_segments_fixture.py
```

The next independently reviewed commit must exercise the **existing** real large
PostgreSQL deletion and retention transactions, establish complete capture of
FK cascades/`SET NULL`, and implement/prove schema-aware target mapping and atomic
application in isolated PostgreSQL and Workers/D1. No source behavior is rewritten
to shrink its log, no arbitrary SQL predicate RPC is introduced, and no schema or
runtime route is changed here. Until that work passes, large-transaction capture,
null mapping, actual D1 atomic apply and production promotion remain unverified.
