package feedtransfer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
)

func segmentedDelete(i int) SegmentChange {
	h := strings.Repeat("d", 64)
	return SegmentChange{Row: Change{Table: "feed_runtime_events", Key: fmt.Sprintf("synthetic-delete-%09d", i), Operation: "delete", Actor: &ActorScope{42, 5}}, BeforeHash: &h}
}
func segmentEnvelope(m Manifest, index, ordinal int64, previous string, changes []SegmentChange) TransactionSegment {
	return TransactionSegment{Version: 2, TransactionID: canonicalTransactionID(m, m.FromSequence+1), Sequence: m.FromSequence + 1, PreviousCommitHash: m.AnchorHash, Index: index, FirstOrdinal: ordinal, PreviousSegmentHash: previous, Changes: changes}
}
func buildSeal(t *testing.T, m Manifest, chunks int, produce func(int) []SegmentChange) TransactionSeal {
	t.Helper()
	mh, err := ManifestHash(m)
	if err != nil {
		t.Fatal(err)
	}
	s := TransactionSeal{Version: 2, ManifestHash: mh, TransactionID: canonicalTransactionID(m, m.FromSequence+1), Sequence: m.FromSequence + 1, PreviousCommitHash: m.AnchorHash, SegmentCount: int64(chunks), LastSegmentHash: emptyChain(), FloorChainHash: emptyChain()}
	for i := 0; i < chunks; i++ {
		v := segmentEnvelope(m, int64(i), s.TotalChanges, s.LastSegmentHash, produce(i))
		h, n, err := SegmentHash(m, v)
		if err != nil {
			t.Fatal(err)
		}
		s.LastSegmentHash = h
		s.TotalChanges += int64(len(v.Changes))
		s.ContentBytes += n
		for _, c := range v.Changes {
			if c.Row.Operation == "floor" {
				s.FloorRecords++
				s.FloorChainHash = floorChain(s.FloorChainHash, c.Row)
			}
		}
	}
	s.TransactionHash, err = SegmentedTransactionHash(m, s)
	if err != nil {
		t.Fatal(err)
	}
	s.Hash, err = TransactionSealHash(m, s)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func sealSegment(t *testing.T, m Manifest, s TransactionSeal, p StageProgress, changes []SegmentChange) TransactionSegment {
	t.Helper()
	v := segmentEnvelope(m, p.NextSegment, p.NextOrdinal, p.LastSegmentHash, changes)
	v.SealHash = s.Hash
	var err error
	v.Hash, _, err = SegmentHash(m, v)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func stageStart(t *testing.T, m Manifest, s TransactionSeal, cp Checkpoint) StageProgress {
	t.Helper()
	p, err := BeginStaging(m, s, cp, DefaultSegmentQuota())
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func stageNext(t *testing.T, m Manifest, s TransactionSeal, cp Checkpoint, p StageProgress, changes []SegmentChange) StagingProposal {
	t.Helper()
	v := sealSegment(t, m, s, p, changes)
	out, err := ValidateSegment(m, s, cp, DefaultSegmentQuota(), p, v, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.CaptureConnected || out.DurableStorageVerified || out.PromotionReady {
		t.Fatal("staging claimed implementation evidence")
	}
	return out
}
func fakeAtomicReceiptForProtocolTest(t *testing.T, m Manifest, s TransactionSeal, cp Checkpoint, p StageProgress, floors []Floor) AtomicCommitReceipt {
	t.Helper()
	before, err := checkpointHash(cp)
	if err != nil {
		t.Fatal(err)
	}
	floorSet, err := floorMap(floors)
	if err != nil {
		t.Fatal(err)
	}
	floors = sortedFloors(floorSet)
	r := AtomicCommitReceipt{Version: 2, Outcome: "applied", SealHash: s.Hash, StageProgressHash: p.Hash, BeforeCheckpointHash: before, TransactionHash: s.TransactionHash, FloorChainHash: s.FloorChainHash, DecisionHash: strings.Repeat("b", 64), MapVersion: "synthetic-map-v1", NormalizedStateHash: strings.Repeat("c", 64), AtomicApplyID: "77777777-7777-4777-8777-777777777777", After: Checkpoint{ManifestHash: s.ManifestHash, Sequence: s.Sequence, CommitHash: s.TransactionHash, Floors: floors, Final: s.Sequence == m.ThroughSequence}}
	r.Hash, err = AtomicReceiptHash(r)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func floorReader(changes ...Change) func() (Change, error) {
	i := 0
	return func() (Change, error) {
		if i >= len(changes) {
			return Change{}, io.EOF
		}
		c := changes[i]
		i++
		return c, nil
	}
}

func TestSegmented250kDeletesUseBoundedSegmentsAndDurableResume(t *testing.T) {
	const count = 250000
	chunks := (count + MaxChanges - 1) / MaxChanges
	// Recomputing one chunk at a time permits two passes without retaining any
	// transaction-wide slice or JSON tree. Only the current segment is marshaled.
	peakChanges := 0
	produce := func(index int) []SegmentChange {
		start := index * MaxChanges
		n := min(MaxChanges, count-start)
		if n > peakChanges {
			peakChanges = n
		}
		out := make([]SegmentChange, n)
		for i := range out {
			out[i] = segmentedDelete(start + i)
			out[i].Row.Table = "feed.events"
		}
		return out
	}
	m := manifest(t, "postgres", 1, nil)
	cp := begin(t, m, nil)
	runtime.GC()
	var initial runtime.MemStats
	runtime.ReadMemStats(&initial)
	s := buildSeal(t, m, chunks, produce)
	p := stageStart(t, m, s, cp)
	var latest DurableStageReceipt
	maxProgressBytes := 0
	for i := 0; i < chunks; i++ {
		v := sealSegment(t, m, s, p, produce(i))
		wire, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeTransactionSegment(bytes.NewReader(wire))
		if err != nil {
			t.Fatal(err)
		}
		out, err := ValidateSegment(m, s, cp, DefaultSegmentQuota(), p, decoded, nil)
		if err != nil {
			t.Fatalf("segment %d: %v", i, err)
		}
		latest = out.Receipt
		// Simulate restart from SERIALIZED caller-persisted receipt. This is an
		// in-test protocol model, not evidence of real DB persistence.
		receiptBytes, _ := json.Marshal(latest)
		r, err := DecodeDurableStageReceipt(bytes.NewReader(receiptBytes))
		if err != nil {
			t.Fatal(err)
		}
		p, err = RestoreStaging(m, s, cp, DefaultSegmentQuota(), r)
		if err != nil {
			t.Fatal(err)
		}
		stateBytes, _ := json.Marshal(p)
		maxProgressBytes = max(maxProgressBytes, len(stateBytes))
		if cp.Sequence != 0 || cp.Final {
			t.Fatal("segment advanced applied checkpoint")
		}
	}
	if !p.Ready || p.NextOrdinal != count || peakChanges > MaxChanges || maxProgressBytes > 2048 {
		t.Fatal("unbounded state or incomplete stream")
	}
	if _, err := ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), latest, "synthetic-map-v1", nil, nil, nil); err == nil {
		t.Fatal("staging certified atomic apply")
	}
	runtime.GC()
	var final runtime.MemStats
	runtime.ReadMemStats(&final)
	if final.HeapAlloc > initial.HeapAlloc+(32<<20) {
		t.Fatalf("retained transaction-sized memory: delta=%d", final.HeapAlloc-initial.HeapAlloc)
	}
	t.Logf("synthetic changes=%d segments=%d max_changes=%d max_progress_bytes=%d; no database apply", count, chunks, peakChanges, maxProgressBytes)
}
func TestSegmentedMissingReorderedMixedAndConflictingReceipts(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	produce := func(i int) []SegmentChange { return []SegmentChange{segmentedDelete(i)} }
	s := buildSeal(t, m, 2, produce)
	p := stageStart(t, m, s, cp)
	v0 := sealSegment(t, m, s, p, produce(0))
	one := stageNext(t, m, s, cp, p, produce(0))
	v1 := sealSegment(t, m, s, one.Progress, produce(1))
	_, err := ValidateSegment(m, s, cp, DefaultSegmentQuota(), p, v1, nil)
	code(t, err, "seg_order")
	// A computed-but-unpersisted receipt is not usable against an older durable progress.
	_, err = ValidateSegment(m, s, cp, DefaultSegmentQuota(), p, v0, &one.Receipt)
	code(t, err, "seg_receipt_uncommitted")
	retry, err := ValidateSegment(m, s, cp, DefaultSegmentQuota(), one.Progress, v0, &one.Receipt)
	if err != nil || !retry.Duplicate || retry.Progress.Hash != one.Progress.Hash {
		t.Fatal("ack lost retry", err)
	}
	_, err = ValidateSegment(m, s, cp, DefaultSegmentQuota(), one.Progress, v0, nil)
	code(t, err, "seg_order")
	changed := clone(v0)
	changed.Changes[0].BeforeHash = new(string)
	*changed.Changes[0].BeforeHash = strings.Repeat("e", 64)
	changed.Hash, _, _ = SegmentHash(m, changed)
	_, err = ValidateSegment(m, s, cp, DefaultSegmentQuota(), one.Progress, changed, &one.Receipt)
	code(t, err, "seg_receipt_conflict")
	cases := []struct {
		code string
		edit func(*TransactionSegment)
	}{
		{"unknown_version", func(v *TransactionSegment) { v.Version = 3 }},
		{"seg_identity", func(v *TransactionSegment) { v.SealHash = strings.Repeat("f", 64) }},
		{"seg_identity", func(v *TransactionSegment) { v.Sequence++ }},
		{"seg_hash", func(v *TransactionSegment) { v.Hash = strings.Repeat("f", 64) }},
		{"seg_before_hash", func(v *TransactionSegment) { v.Changes[0].BeforeHash = nil }},
	}
	for i, tt := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			v := clone(v1)
			tt.edit(&v)
			_, err := ValidateSegment(m, s, cp, DefaultSegmentQuota(), one.Progress, v, nil)
			code(t, err, tt.code)
		})
	}
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), one.Receipt, "synthetic-map-v1", nil, nil, nil)
	code(t, err, "seg_incomplete")
	badProgress := clone(one.Progress)
	badProgress.NextOrdinal++
	_, err = ValidateSegment(m, s, cp, DefaultSegmentQuota(), badProgress, v1, nil)
	code(t, err, "seg_progress")
	badReceipt := clone(one.Receipt)
	badReceipt.After.NextOrdinal++
	_, err = RestoreStaging(m, s, cp, DefaultSegmentQuota(), badReceipt)
	code(t, err, "seg_progress")
}
func TestSegmentedSealQuotaAndGlobalOrder(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	produce := func(i int) []SegmentChange { return []SegmentChange{segmentedDelete(i)} }
	s := buildSeal(t, m, 2, produce)
	q := DefaultSegmentQuota()
	q.MaxChanges = 1
	_, err := BeginStaging(m, s, cp, q)
	code(t, err, "seg_quota")
	q = DefaultSegmentQuota()
	q.MaxContentBytes = s.ContentBytes - 1
	_, err = BeginStaging(m, s, cp, q)
	code(t, err, "seg_quota")
	q = DefaultSegmentQuota()
	q.MaxSegments = 1
	_, err = BeginStaging(m, s, cp, q)
	code(t, err, "seg_quota")
	bad := s
	bad.ContentBytes++
	_, err = BeginStaging(m, bad, cp, DefaultSegmentQuota())
	code(t, err, "seg_transaction_hash")
	bad.TransactionHash, _ = SegmentedTransactionHash(m, bad)
	bad.Hash, _ = TransactionSealHash(m, bad)
	p := stageStart(t, m, bad, cp)
	one := stageNext(t, m, bad, cp, p, produce(0))
	v := sealSegment(t, m, bad, one.Progress, produce(1))
	_, err = ValidateSegment(m, bad, cp, DefaultSegmentQuota(), one.Progress, v, nil)
	code(t, err, "seg_seal_mismatch")
	// Globally repeated/reversed keys are rejected with only one retained cursor.
	p = stageStart(t, m, s, cp)
	one = stageNext(t, m, s, cp, p, produce(0))
	v = sealSegment(t, m, s, one.Progress, produce(0))
	_, err = ValidateSegment(m, s, cp, DefaultSegmentQuota(), one.Progress, v, nil)
	code(t, err, "seg_change_order")
	// A structurally valid seal with a wrong terminal hash fails at completion.
	bad = s
	bad.LastSegmentHash = strings.Repeat("f", 64)
	bad.TransactionHash, _ = SegmentedTransactionHash(m, bad)
	bad.Hash, _ = TransactionSealHash(m, bad)
	p = stageStart(t, m, bad, cp)
	one = stageNext(t, m, bad, cp, p, produce(0))
	v = sealSegment(t, m, bad, one.Progress, produce(1))
	_, err = ValidateSegment(m, bad, cp, DefaultSegmentQuota(), one.Progress, v, nil)
	code(t, err, "seg_seal_mismatch")
}
func TestSegmentedAtomicReceiptAndWholeTransactionFloors(t *testing.T) {
	overlay := []Floor{{7, 3}}
	m := manifest(t, "cf_d1_r2", 1, overlay)
	cp := begin(t, m, overlay)
	floor := Change{Table: "feed_profile_floors", Key: "42", Operation: "floor", Actor: &ActorScope{42, 5}}
	chunks := [][]SegmentChange{{{Row: floor}}, {segmentedDelete(0)}}
	s := buildSeal(t, m, 2, func(i int) []SegmentChange { return chunks[i] })
	p := stageStart(t, m, s, cp)
	one := stageNext(t, m, s, cp, p, chunks[0])
	two := stageNext(t, m, s, cp, one.Progress, chunks[1])
	row0 := sealSegment(t, m, s, p, chunks[0])
	row1 := sealSegment(t, m, s, one.Progress, chunks[1])
	readRows := func() func() (TransactionSegment, error) { return segmentReader(row0, row1) }
	semantics, err := ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), floorReader(floor), readRows())
	if err != nil {
		t.Fatal(err)
	}
	r := fakeAtomicReceiptForProtocolTest(t, m, s, cp, two.Progress, []Floor{{7, 3}, {42, 5}})
	r.DecisionHash = semantics.DecisionHash
	r.Hash, _ = AtomicReceiptHash(r)
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &r, nil, readRows())
	code(t, err, "staged_floors_required")
	out, err := ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &r, floorReader(floor), readRows())
	if err != nil {
		t.Fatal(err)
	}
	if !out.AtomicReceiptMatched || out.Checkpoint.Sequence != 1 || out.PromotionReady || out.AtomicApplicationVerified || out.RowSchemaValidated || out.CaptureConnected {
		t.Fatal("receipt interpretation claimed DB evidence")
	}
	if cp.Sequence != 0 || len(cp.Floors) != 1 {
		t.Fatal("mutated applied checkpoint")
	}
	bad := r
	bad.After = clone(r.After)
	bad.After.Floors = []Floor{{7, 3}}
	bad.Hash, _ = AtomicReceiptHash(bad)
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &bad, floorReader(floor), readRows())
	code(t, err, "atomic_floor_mismatch")
	bad = r
	bad.Outcome = "accepted"
	bad.Hash, _ = AtomicReceiptHash(bad)
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &bad, floorReader(floor), readRows())
	code(t, err, "atomic_receipt")
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, "unapproved-map", &r, floorReader(floor), readRows())
	code(t, err, "atomic_receipt")
	changed := clone(floor)
	changed.Actor.ProfileVersion = 4
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &r, floorReader(changed), readRows())
	code(t, err, "staged_floor_hash")
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &r, floorReader(floor, floor), readRows())
	code(t, err, "staged_floors_extra")
}

func segmentReader(rows ...TransactionSegment) func() (TransactionSegment, error) {
	i := 0
	return func() (TransactionSegment, error) {
		if i >= len(rows) {
			return TransactionSegment{}, io.EOF
		}
		v := rows[i]
		i++
		return v, nil
	}
}

func TestSegmentedSemanticsRejectUnfencedErasureAndBindSuppression(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	hash := strings.Repeat("d", 64)
	erase := SegmentChange{Row: Change{Table: "feed_user_tag_proposals", Key: "synthetic", Operation: "erase", Actor: &ActorScope{42, 5}}, BeforeHash: &hash}
	s := buildSeal(t, m, 1, func(int) []SegmentChange { return []SegmentChange{erase} })
	p := stageStart(t, m, s, cp)
	seg := sealSegment(t, m, s, p, []SegmentChange{erase})
	ready := stageNext(t, m, s, cp, p, []SegmentChange{erase})
	r := fakeAtomicReceiptForProtocolTest(t, m, s, cp, ready.Progress, nil)
	_, err := ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), nil, segmentReader(seg))
	code(t, err, "tombstone_without_floor")
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), ready.Receipt, r.MapVersion, &r, nil, segmentReader(seg))
	code(t, err, "tombstone_without_floor")
	floor := Change{Table: "feed_profile_floors", Key: "42", Operation: "floor", Actor: &ActorScope{42, 5}}
	chunks := [][]SegmentChange{{{Row: floor}}, {{Row: user("cf_d1_r2", 5)}}}
	s = buildSeal(t, m, 2, func(i int) []SegmentChange { return chunks[i] })
	p = stageStart(t, m, s, cp)
	seg0 := sealSegment(t, m, s, p, chunks[0])
	one := stageNext(t, m, s, cp, p, chunks[0])
	seg1 := sealSegment(t, m, s, one.Progress, chunks[1])
	two := stageNext(t, m, s, cp, one.Progress, chunks[1])
	r = fakeAtomicReceiptForProtocolTest(t, m, s, cp, two.Progress, []Floor{{42, 5}})
	sem, err := ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), floorReader(floor), segmentReader(seg0, seg1))
	if err != nil || sem.Suppressed != 1 {
		t.Fatal("lost v1 suppression", err)
	}
	_, err = ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), two.Receipt, r.MapVersion, &r, floorReader(floor), segmentReader(seg0, seg1))
	code(t, err, "atomic_decision_mismatch")
	_, err = ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), floorReader(floor), segmentReader(seg0))
	code(t, err, "staged_rows_incomplete")
	_, err = ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), floorReader(floor), segmentReader(seg0, seg1, seg1))
	code(t, err, "staged_rows_extra")
	altered := clone(seg1)
	altered.Changes[0].Row.Actor.ProfileVersion = 6
	altered.Hash, _, _ = SegmentHash(m, altered)
	_, err = ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), floorReader(floor), segmentReader(seg0, altered))
	code(t, err, "seg_seal_mismatch")
}
func TestSegmentedAtomicAckLostRestartsAtAppliedHead(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	chunks := []SegmentChange{segmentedDelete(0)}
	s := buildSeal(t, m, 1, func(int) []SegmentChange { return chunks })
	p := stageStart(t, m, s, cp)
	seg := sealSegment(t, m, s, p, chunks)
	ready := stageNext(t, m, s, cp, p, chunks)
	sem, err := ValidateStagedSemantics(m, s, cp, DefaultSegmentQuota(), nil, segmentReader(seg))
	if err != nil {
		t.Fatal(err)
	}
	r := fakeAtomicReceiptForProtocolTest(t, m, s, cp, ready.Progress, nil)
	r.DecisionHash = sem.DecisionHash
	r.Hash, _ = AtomicReceiptHash(r)
	proposed, err := ProposeCheckpointAdvance(m, s, cp, DefaultSegmentQuota(), ready.Receipt, r.MapVersion, &r, nil, segmentReader(seg))
	if err != nil {
		t.Fatal(err)
	}
	// This models a persisted target ledger, not a database transaction test.
	head := AppliedHead{Checkpoint: proposed.Checkpoint, AtomicReceiptHash: proposed.AtomicReceiptHash}
	wire, _ := json.Marshal(r)
	loaded, err := DecodeAtomicCommitReceipt(bytes.NewReader(wire))
	if err != nil {
		t.Fatal(err)
	}
	head = clone(head)
	retry, err := ConfirmCommittedTransaction(m, s, head, loaded, r.MapVersion)
	if err != nil || !retry.Duplicate || retry.Checkpoint.Sequence != 1 || !retry.Checkpoint.Final || retry.PromotionReady || retry.AtomicApplicationVerified {
		t.Fatal("atomic lost ack recovery", err)
	}
	changed := loaded
	changed.NormalizedStateHash = strings.Repeat("f", 64)
	changed.Hash, _ = AtomicReceiptHash(changed)
	_, err = ConfirmCommittedTransaction(m, s, head, changed, r.MapVersion)
	code(t, err, "atomic_receipt_conflict")
	rolledBack := head
	rolledBack.Checkpoint = cp
	_, err = ConfirmCommittedTransaction(m, s, rolledBack, loaded, r.MapVersion)
	code(t, err, "atomic_head_mismatch")
}
func TestAtomicReceiptDecoderSupportsExactFloorQuota(t *testing.T) {
	r := AtomicCommitReceipt{Version: 2, After: Checkpoint{Floors: make([]Floor, MaxFloorActors)}}
	for i := range r.After.Floors {
		r.After.Floors[i] = Floor{int64(i) + 1, MaxSafeInteger}
	}
	wire, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) > MaxBatchBytes {
		t.Fatal("test receipt exceeded wire bound")
	}
	decoded, err := DecodeAtomicCommitReceipt(bytes.NewReader(wire))
	if err != nil || len(decoded.After.Floors) != MaxFloorActors {
		t.Fatal("legitimate floor quota cannot restart", err)
	}
	r.After.Floors = append(r.After.Floors, Floor{MaxFloorActors + 1, 1})
	wire, _ = json.Marshal(r)
	_, err = DecodeAtomicCommitReceipt(bytes.NewReader(wire))
	code(t, err, "floor_limit")
	bad := strings.Replace(string(wire), `"outcome":""`, `"outcome":"","outcome":""`, 1)
	_, err = DecodeAtomicCommitReceipt(strings.NewReader(bad))
	code(t, err, "duplicate_json_key")
}
func TestSegmentedSharedCrossLanguageFixture(t *testing.T) {
	var f struct {
		Synthetic     bool              `json:"synthetic"`
		Manifest      json.RawMessage   `json:"manifest"`
		InitialFloors []Floor           `json:"initialFloors"`
		Seal          json.RawMessage   `json:"seal"`
		Segments      []json.RawMessage `json:"segments"`
		Receipts      []json.RawMessage `json:"receipts"`
		Atomic        json.RawMessage   `json:"syntheticAtomicReceipt"`
	}
	wire, err := os.ReadFile("testdata/segments-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(wire, &f); err != nil {
		t.Fatal(err)
	}
	if !f.Synthetic {
		t.Fatal("fixture must be synthetic")
	}
	m, err := DecodeManifest(bytes.NewReader(f.Manifest))
	if err != nil {
		t.Fatal(err)
	}
	seal, err := DecodeTransactionSeal(bytes.NewReader(f.Seal))
	if err != nil {
		t.Fatal(err)
	}
	cp := begin(t, m, f.InitialFloors)
	p := stageStart(t, m, seal, cp)
	var last DurableStageReceipt
	var segments []TransactionSegment
	var floors []Change
	for i, raw := range f.Segments {
		seg, err := DecodeTransactionSegment(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		out, err := ValidateSegment(m, seal, cp, DefaultSegmentQuota(), p, seg, nil)
		if err != nil {
			t.Fatal(err)
		}
		golden, err := DecodeDurableStageReceipt(bytes.NewReader(f.Receipts[i]))
		if err != nil || golden.Hash != out.Receipt.Hash {
			t.Fatal("independent stage receipt mismatch", err)
		}
		last = golden
		p, err = RestoreStaging(m, seal, cp, DefaultSegmentQuota(), last)
		if err != nil {
			t.Fatal(err)
		}
		segments = append(segments, seg)
		for _, c := range seg.Changes {
			if c.Row.Operation == "floor" {
				floors = append(floors, c.Row)
			}
		}
	}
	atomic, err := DecodeAtomicCommitReceipt(bytes.NewReader(f.Atomic))
	if err != nil {
		t.Fatal(err)
	}
	out, err := ProposeCheckpointAdvance(m, seal, cp, DefaultSegmentQuota(), last, atomic.MapVersion, &atomic, floorReader(floors...), segmentReader(segments...))
	if err != nil || !out.AtomicReceiptMatched {
		t.Fatal("independent decision/atomic hash mismatch", err)
	}
	// U+E000 sorts before U+10000 by UTF-8 bytes; JS default UTF-16 sort reverses them.
	if segments[1].Changes[0].Row.Key != "synthetic-\ue000" || segments[2].Changes[0].Row.Key != "synthetic-\U00010000" {
		t.Fatal("fixture lost cross-runtime ordering case")
	}
}
func TestFloorPairCannotCrossSegmentAndUTF8OrderIsStrict(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	floor := Change{Table: "feed_profile_floors", Key: "42", Operation: "floor", Actor: &ActorScope{42, 5}}
	upsert := clone(floor)
	upsert.Operation = "upsert"
	upsert.Image = []byte(`{"github_id":42,"profile_floor":5}`)
	before := strings.Repeat("d", 64)
	good := segmentEnvelope(m, 0, 0, emptyChain(), []SegmentChange{{Row: floor}, {Row: upsert, BeforeHash: &before}})
	if _, _, err := SegmentHash(m, good); err != nil {
		t.Fatal(err)
	}
	split := segmentEnvelope(m, 1, 1, emptyChain(), []SegmentChange{{Row: upsert, BeforeHash: &before}})
	_, _, err := SegmentHash(m, split)
	code(t, err, "floor_missing")
	first, second := segmentedDelete(0), segmentedDelete(1)
	first.Row.Key = "\U00010000"
	second.Row.Key = "\ue000"
	wrong := segmentEnvelope(m, 0, 0, emptyChain(), []SegmentChange{first, second})
	_, _, err = SegmentHash(m, wrong)
	code(t, err, "seg_change_order")
}
