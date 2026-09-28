package feedtransfer

import (
	"encoding/json"
	"io"
	"reflect"
)

func sealShape(m Manifest, s TransactionSeal, q SegmentQuota) error {
	if s.Version != SegmentedVersion {
		return invalid("unknown_version")
	}
	h, err := ManifestHash(m)
	if err != nil {
		return err
	}
	ceiling := DefaultSegmentQuota()
	if !positive(q.MaxChanges) || q.MaxChanges > ceiling.MaxChanges || !positive(q.MaxContentBytes) || q.MaxContentBytes > ceiling.MaxContentBytes || !positive(q.MaxSegments) || q.MaxSegments > ceiling.MaxSegments {
		return invalid("seg_quota")
	}
	if s.ManifestHash != h || !positive(s.Sequence) || s.Sequence <= m.FromSequence || s.Sequence > m.ThroughSequence || s.TransactionID != canonicalTransactionID(m, s.Sequence) || !digest(s.PreviousCommitHash) {
		return invalid("seg_identity")
	}
	if !positive(s.TotalChanges) || s.TotalChanges > q.MaxChanges || !positive(s.ContentBytes) || s.ContentBytes > q.MaxContentBytes || !positive(s.SegmentCount) || s.SegmentCount > q.MaxSegments || s.TotalChanges < s.SegmentCount || s.TotalChanges > s.SegmentCount*MaxChanges {
		return invalid("seg_quota")
	}
	if !digest(s.LastSegmentHash) || s.LastSegmentHash == emptyChain() || !safe(s.FloorRecords) || s.FloorRecords > s.TotalChanges || !digest(s.FloorChainHash) || (s.FloorRecords == 0) != (s.FloorChainHash == emptyChain()) {
		return invalid("seg_seal_shape")
	}
	return nil
}
func validateSeal(m Manifest, s TransactionSeal, q SegmentQuota) error {
	if err := sealShape(m, s, q); err != nil {
		return err
	}
	h, err := TransactionSealHash(m, s)
	if err != nil {
		return err
	}
	if s.Hash != h {
		return invalid("seg_seal_hash")
	}
	return nil
}
func validateSegmentRows(m Manifest, s TransactionSegment) error {
	if s.Version != SegmentedVersion {
		return invalid("unknown_version")
	}
	if !safe(s.Index) || s.Index >= DefaultSegmentQuota().MaxSegments || !safe(s.FirstOrdinal) || s.FirstOrdinal >= DefaultSegmentQuota().MaxChanges || !digest(s.PreviousSegmentHash) {
		return invalid("seg_shape")
	}
	if len(s.Changes) > MaxChanges {
		return invalid("seg_shape")
	}
	rows := make([]Change, len(s.Changes))
	for i, c := range s.Changes {
		rows[i] = c.Row
		if c.BeforeHash != nil && !digest(*c.BeforeHash) {
			return invalid("seg_before_hash")
		}
		if (c.Row.Operation == "delete" || c.Row.Operation == "erase" || c.Row.Operation == "command_tombstone") && c.BeforeHash == nil {
			return invalid("seg_before_hash")
		}
		if c.Row.Operation == "floor" && c.BeforeHash != nil {
			return invalid("seg_before_hash")
		}
		if i > 0 {
			if err := nextCursor(cursorFor(s.Changes[i-1].Row), cursorFor(c.Row)); err != nil {
				return err
			}
		}
	}
	// v1's per-transaction bound is reused as a per-segment bound. A floor and
	// its matching tombstone after-image remain together in one segment.
	return validateTransaction(m, Transaction{Sequence: s.Sequence, TransactionID: s.TransactionID, PreviousHash: s.PreviousCommitHash, Changes: rows})
}
func nextCursor(previous, next *ChangeCursor) error {
	if previous == nil {
		return nil
	}
	if cursorOrder(previous) >= cursorOrder(next) {
		return invalid("seg_change_order")
	}
	if previous.Table == next.Table && previous.Key == next.Key && !(previous.Operation == "floor" && next.Operation == "upsert") {
		return invalid("duplicate_change")
	}
	return nil
}
func validateAppliedBefore(m Manifest, s TransactionSeal, c Checkpoint) error {
	h, err := ManifestHash(m)
	if err != nil {
		return err
	}
	if c.ManifestHash != h || !safe(c.Sequence) || c.Sequence < m.FromSequence || c.Sequence >= m.ThroughSequence || c.Sequence+1 != s.Sequence || c.CommitHash != s.PreviousCommitHash || c.Final {
		return invalid("seg_checkpoint")
	}
	if _, err := floorMap(c.Floors); err != nil {
		return err
	}
	if c.Sequence == m.FromSequence {
		fh, _ := DeletionFloorsHash(c.Floors)
		if c.CommitHash != m.AnchorHash || fh != m.DeletionFloorsSHA256 || int64(len(c.Floors)) != m.DeletionFloorActors {
			return invalid("floor_overlay")
		}
	}
	return nil
}
func BeginStaging(m Manifest, s TransactionSeal, c Checkpoint, q SegmentQuota) (StageProgress, error) {
	if err := validateSeal(m, s, q); err != nil {
		return StageProgress{}, err
	}
	if err := validateAppliedBefore(m, s, c); err != nil {
		return StageProgress{}, err
	}
	p := StageProgress{SealHash: s.Hash, LastSegmentHash: emptyChain(), FloorChainHash: emptyChain()}
	p.Hash = progressHash(p)
	return p, nil
}
func validateProgress(m Manifest, s TransactionSeal, p StageProgress) error {
	if p.SealHash != s.Hash || p.Hash != progressHash(p) || !safe(p.NextSegment) || p.NextSegment > s.SegmentCount || !safe(p.NextOrdinal) || p.NextOrdinal > s.TotalChanges || !safe(p.ContentBytes) || p.ContentBytes > s.ContentBytes || !digest(p.LastSegmentHash) || !safe(p.FloorRecords) || p.FloorRecords > s.FloorRecords || !digest(p.FloorChainHash) || (p.FloorRecords == 0) != (p.FloorChainHash == emptyChain()) {
		return invalid("seg_progress")
	}
	if p.NextSegment == 0 {
		if p.NextOrdinal != 0 || p.ContentBytes != 0 || p.LastSegmentHash != emptyChain() || p.LastRow != nil || p.FloorRecords != 0 || p.Ready {
			return invalid("seg_progress")
		}
	} else {
		if p.NextOrdinal < p.NextSegment || p.NextOrdinal > p.NextSegment*MaxChanges || p.ContentBytes == 0 || p.LastSegmentHash == emptyChain() || p.LastRow == nil || !clean(p.LastRow.Key, 1024) {
			return invalid("seg_progress")
		}
		rule, ok := tableRule(m.Source.Profile, m.Source.Schema, p.LastRow.Table)
		if !ok || rule.Mode != "capture" {
			return invalid("seg_progress")
		}
		switch p.LastRow.Operation {
		case "upsert", "delete", "erase", "floor", "command_tombstone":
		default:
			return invalid("seg_progress")
		}
	}
	if p.Ready != (p.NextSegment == s.SegmentCount) {
		return invalid("seg_progress")
	}
	if p.Ready && (p.NextOrdinal != s.TotalChanges || p.ContentBytes != s.ContentBytes || p.LastSegmentHash != s.LastSegmentHash || p.FloorRecords != s.FloorRecords || p.FloorChainHash != s.FloorChainHash) {
		return invalid("seg_seal_mismatch")
	}
	return nil
}

// RestoreStaging does not find or persist receipts. The caller must load the
// latest receipt atomically committed with immutable segment bytes. Receipts
// supplied by an unauthenticated client are not durable proof.
func RestoreStaging(m Manifest, s TransactionSeal, c Checkpoint, q SegmentQuota, r DurableStageReceipt) (StageProgress, error) {
	initial, err := BeginStaging(m, s, c, q)
	if err != nil {
		return StageProgress{}, err
	}
	if r.Version != SegmentedVersion || r.SealHash != s.Hash || !safe(r.SegmentIndex) || r.SegmentIndex+1 != r.After.NextSegment || r.SegmentHash != r.After.LastSegmentHash || !digest(r.BeforeProgressHash) || r.Hash != stageReceiptHash(r) {
		return StageProgress{}, invalid("seg_receipt")
	}
	if r.SegmentIndex == 0 && r.BeforeProgressHash != initial.Hash {
		return StageProgress{}, invalid("seg_receipt")
	}
	if err := validateProgress(m, s, r.After); err != nil {
		return StageProgress{}, err
	}
	p := r.After
	if p.LastRow != nil {
		v := *p.LastRow
		p.LastRow = &v
	}
	return p, nil
}

// ValidateSegment returns a proposed receipt. Persist bytes+receipt+progress in
// one staging transaction before acknowledging. There is no applied checkpoint
// in this result; Ready only permits preparation of a future atomic apply.
func ValidateSegment(m Manifest, s TransactionSeal, c Checkpoint, q SegmentQuota, p StageProgress, v TransactionSegment, prior *DurableStageReceipt) (StagingProposal, error) {
	out := StagingProposal{}
	if _, err := BeginStaging(m, s, c, q); err != nil {
		return out, err
	}
	if err := validateProgress(m, s, p); err != nil {
		return out, err
	}
	if v.SealHash != s.Hash || v.TransactionID != s.TransactionID || v.Sequence != s.Sequence || v.PreviousCommitHash != s.PreviousCommitHash || v.Index >= s.SegmentCount {
		return out, invalid("seg_identity")
	}
	hash, size, err := SegmentHash(m, v)
	if err != nil {
		return out, err
	}
	if v.Hash != hash {
		return out, invalid("seg_hash")
	}
	wire, err := json.Marshal(v)
	if err != nil || len(wire) > MaxBatchBytes {
		return out, invalid("body_too_large")
	}
	if prior != nil {
		r, err := RestoreStaging(m, s, c, q, *prior)
		if err != nil {
			return out, err
		}
		if prior.SegmentIndex != v.Index || prior.SegmentHash != v.Hash || r.NextOrdinal != v.FirstOrdinal+int64(len(v.Changes)) {
			return out, invalid("seg_receipt_conflict")
		}
		if p.NextSegment < r.NextSegment || (p.NextSegment == r.NextSegment && p.Hash != r.Hash) {
			return out, invalid("seg_receipt_uncommitted")
		}
		out.Progress = p
		out.Receipt = *prior
		out.Duplicate = true
		out.ContentComplete = p.Ready
		return out, nil
	}
	if p.Ready || v.Index != p.NextSegment || v.FirstOrdinal != p.NextOrdinal || v.PreviousSegmentHash != p.LastSegmentHash {
		return out, invalid("seg_order")
	}
	if err := nextCursor(p.LastRow, cursorFor(v.Changes[0].Row)); err != nil {
		return out, err
	}
	n := p
	n.NextSegment++
	n.NextOrdinal += int64(len(v.Changes))
	n.ContentBytes += size
	n.LastSegmentHash = v.Hash
	n.LastRow = cursorFor(v.Changes[len(v.Changes)-1].Row)
	for _, c := range v.Changes {
		if c.Row.Operation == "floor" {
			n.FloorRecords++
			n.FloorChainHash = floorChain(n.FloorChainHash, c.Row)
		}
	}
	n.Ready = n.NextSegment == s.SegmentCount
	n.Hash = progressHash(n)
	if err := validateProgress(m, s, n); err != nil {
		return out, err
	}
	r := DurableStageReceipt{Version: SegmentedVersion, SealHash: s.Hash, SegmentIndex: v.Index, SegmentHash: v.Hash, BeforeProgressHash: p.Hash, After: n}
	r.Hash = stageReceiptHash(r)
	out.Progress = n
	out.Receipt = r
	out.ContentComplete = n.Ready
	return out, nil
}

// ProposeCheckpointAdvance checks a caller-authenticated atomic commit receipt.
// It cannot observe DB commit or validate row mapping, and therefore explicitly
// leaves AtomicApplicationVerified and PromotionReady false. A staging receipt
// alone, an omitted apply receipt, or an "accepted" outcome never advances.
func ProposeCheckpointAdvance(m Manifest, s TransactionSeal, before Checkpoint, q SegmentQuota, stage DurableStageReceipt, expectedMapVersion string, committed *AtomicCommitReceipt, readFloor func() (Change, error), readSegments func() (TransactionSegment, error)) (AdvanceProposal, error) {
	out := AdvanceProposal{}
	p, err := RestoreStaging(m, s, before, q, stage)
	if err != nil {
		return out, err
	}
	if !p.Ready {
		return out, invalid("seg_incomplete")
	}
	if committed == nil {
		return out, invalid("atomic_receipt_required")
	}
	r := *committed
	bh, err := checkpointHash(before)
	if err != nil {
		return out, err
	}
	if r.Version != SegmentedVersion || r.Outcome != "applied" || r.SealHash != s.Hash || r.StageProgressHash != p.Hash || r.BeforeCheckpointHash != bh || r.TransactionHash != s.TransactionHash || r.FloorChainHash != s.FloorChainHash || !clean(expectedMapVersion, 80) || r.MapVersion != expectedMapVersion || !digest(r.DecisionHash) || !digest(r.NormalizedStateHash) || !uuidPattern.MatchString(r.AtomicApplyID) {
		return out, invalid("atomic_receipt")
	}
	ah, err := AtomicReceiptHash(r)
	if err != nil {
		return out, err
	}
	if r.Hash != ah {
		return out, invalid("atomic_receipt_hash")
	}
	if r.After.ManifestHash != s.ManifestHash || r.After.Sequence != s.Sequence || r.After.CommitHash != s.TransactionHash || r.After.Final != (s.Sequence == m.ThroughSequence) {
		return out, invalid("atomic_checkpoint")
	}
	floors, err := floorMap(r.After.Floors)
	if err != nil {
		return out, err
	}
	for _, f := range before.Floors {
		if floors[f.GitHubID] < f.ProfileFloor {
			return out, invalid("atomic_floor_regression")
		}
	}
	expected, err := verifyStagedFloors(m, s, before, readFloor)
	if err != nil {
		return out, err
	}
	if !reflect.DeepEqual(sortedFloors(floors), expected) {
		return out, invalid("atomic_floor_mismatch")
	}
	semantics, err := verifyStagedRows(m, s, before, q, expected, readSegments)
	if err != nil {
		return out, err
	}
	if r.DecisionHash != semantics.DecisionHash {
		return out, invalid("atomic_decision_mismatch")
	}
	out.AtomicReceiptHash = r.Hash
	out.Checkpoint = r.After
	out.Checkpoint.Floors = expected
	out.AtomicReceiptMatched = true
	return out, nil
}

// A final pass over just the immutable staged floor records proves their entire
// seal-bound chain before checking the receipt's merged floor set. Segments do
// not retain these rows in memory. This separate pass has v1's MaxFloorActors cap.
func verifyStagedFloors(m Manifest, s TransactionSeal, before Checkpoint, read func() (Change, error)) ([]Floor, error) {
	floors, err := floorMap(before.Floors)
	if err != nil {
		return nil, err
	}
	chain := emptyChain()
	var last *ChangeCursor
	if s.FloorRecords > 0 && read == nil {
		return nil, invalid("staged_floors_required")
	}
	for i := int64(0); i < s.FloorRecords; i++ {
		c, err := read()
		if err != nil {
			return nil, invalid("staged_floors_incomplete")
		}
		tx := Transaction{Sequence: s.Sequence, TransactionID: s.TransactionID, PreviousHash: s.PreviousCommitHash, Changes: []Change{c}}
		if c.Operation != "floor" || validateTransaction(m, tx) != nil {
			return nil, invalid("staged_floor_shape")
		}
		if err := nextCursor(last, cursorFor(c)); err != nil {
			return nil, err
		}
		last = cursorFor(c)
		chain = floorChain(chain, c)
		if c.Actor.ProfileVersion > floors[c.Actor.GitHubID] {
			floors[c.Actor.GitHubID] = c.Actor.ProfileVersion
		}
		if len(floors) > MaxFloorActors {
			return nil, invalid("floor_limit")
		}
	}
	if read != nil {
		if _, err := read(); err != io.EOF {
			return nil, invalid("staged_floors_extra")
		}
	}
	if chain != s.FloorChainHash {
		return nil, invalid("staged_floor_hash")
	}
	return sortedFloors(floors), nil
}

// ValidateStagedSemantics independently rereads the seal-bound floors and every
// immutable staged segment. It prepares a digest of v1's replay decisions,
// without executing a mapper or claiming any target write has committed.
func ValidateStagedSemantics(m Manifest, s TransactionSeal, before Checkpoint, q SegmentQuota, readFloor func() (Change, error), readSegments func() (TransactionSegment, error)) (StagedSemantics, error) {
	if _, err := BeginStaging(m, s, before, q); err != nil {
		return StagedSemantics{}, err
	}
	floors, err := verifyStagedFloors(m, s, before, readFloor)
	if err != nil {
		return StagedSemantics{}, err
	}
	return verifyStagedRows(m, s, before, q, floors, readSegments)
}
func verifyStagedRows(m Manifest, s TransactionSeal, before Checkpoint, q SegmentQuota, merged []Floor, read func() (TransactionSegment, error)) (StagedSemantics, error) {
	out := StagedSemantics{}
	if read == nil {
		return out, invalid("staged_rows_required")
	}
	p, err := BeginStaging(m, s, before, q)
	if err != nil {
		return out, err
	}
	floors, err := floorMap(merged)
	if err != nil {
		return out, err
	}
	fh, _ := DeletionFloorsHash(merged)
	t := newTranscript("ghfind.feed.transfer.decisions.v2")
	t.s(s.Hash)
	t.s(fh)
	t.n(s.TotalChanges)
	for !p.Ready {
		segment, err := read()
		if err != nil {
			return StagedSemantics{}, invalid("staged_rows_incomplete")
		}
		next, err := ValidateSegment(m, s, before, q, p, segment, nil)
		if err != nil {
			return StagedSemantics{}, err
		}
		for _, v := range segment.Changes {
			c := v.Row
			action := "apply"
			switch c.Operation {
			case "floor":
				action = "retain_max_floor"
			case "erase", "command_tombstone":
				if c.Actor.ProfileVersion > floors[c.Actor.GitHubID] {
					return StagedSemantics{}, invalid("tombstone_without_floor")
				}
				if c.Operation == "erase" {
					action = "erase"
				} else {
					action = "tombstone"
				}
			case "upsert":
				rule, _ := tableRule(m.Source.Profile, m.Source.Schema, c.Table)
				if isAuthority(c.Table) {
					action = "stage_control"
				} else if isFloor(c.Table) {
					action = "merge_floor_control"
				} else if c.Actor != nil && c.Actor.ProfileVersion <= floors[c.Actor.GitHubID] && rule.Privacy != "control" {
					action = "suppress_deleted_generation"
					out.Suppressed++
				}
			}
			t.n(out.TotalChanges)
			t.s(action)
			out.TotalChanges++
		}
		p = next.Progress
	}
	if _, err := read(); err != io.EOF {
		return StagedSemantics{}, invalid("staged_rows_extra")
	}
	out.DecisionHash = t.sum()
	return out, nil
}

// ConfirmCommittedTransaction is ONLY for lost-ack recovery of the currently
// applied head. The caller loads head+receipt from the authenticated DB ledger.
// No old in-memory Before checkpoint is needed. It performs no replay/advance.
func ConfirmCommittedTransaction(m Manifest, s TransactionSeal, head AppliedHead, r AtomicCommitReceipt, expectedMapVersion string) (AdvanceProposal, error) {
	out := AdvanceProposal{}
	if err := validateSeal(m, s, DefaultSegmentQuota()); err != nil {
		return out, err
	}
	hash, err := AtomicReceiptHash(r)
	if err != nil {
		return out, err
	}
	if r.Hash != hash || head.AtomicReceiptHash != r.Hash {
		return out, invalid("atomic_receipt_conflict")
	}
	if r.Outcome != "applied" || r.SealHash != s.Hash || r.TransactionHash != s.TransactionHash || r.FloorChainHash != s.FloorChainHash || !digest(r.StageProgressHash) || !digest(r.BeforeCheckpointHash) || !digest(r.DecisionHash) || !digest(r.NormalizedStateHash) || !uuidPattern.MatchString(r.AtomicApplyID) || !clean(expectedMapVersion, 80) || r.MapVersion != expectedMapVersion {
		return out, invalid("atomic_receipt")
	}
	if r.After.ManifestHash != s.ManifestHash || r.After.Sequence != s.Sequence || r.After.CommitHash != s.TransactionHash || r.After.Final != (s.Sequence == m.ThroughSequence) {
		return out, invalid("atomic_checkpoint")
	}
	current, err := checkpointHash(head.Checkpoint)
	if err != nil {
		return out, err
	}
	after, err := checkpointHash(r.After)
	if err != nil {
		return out, err
	}
	if current != after {
		return out, invalid("atomic_head_mismatch")
	}
	out.Checkpoint = head.Checkpoint
	f, _ := floorMap(head.Checkpoint.Floors)
	out.Checkpoint.Floors = sortedFloors(f)
	out.AtomicReceiptHash = r.Hash
	out.AtomicReceiptMatched = true
	out.Duplicate = true
	return out, nil
}
