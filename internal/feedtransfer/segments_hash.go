package feedtransfer

import (
	"io"
	"strconv"
	"strings"
)

func DecodeTransactionSeal(r io.Reader) (TransactionSeal, error) {
	var v TransactionSeal
	err := decode(r, &v, 256<<10)
	return v, err
}
func DecodeTransactionSegment(r io.Reader) (TransactionSegment, error) {
	var v TransactionSegment
	err := decode(r, &v, MaxBatchBytes)
	return v, err
}
func DecodeDurableStageReceipt(r io.Reader) (DurableStageReceipt, error) {
	var v DurableStageReceipt
	err := decode(r, &v, 32<<10)
	return v, err
}

func emptyChain() string { return strings.Repeat("0", 64) }

// Content charge is deliberately independent of JSON whitespace/base64:
// UTF-8 table+key+operation bytes + image bytes + 16 for actor + 64 for beforeHash.
// The separate wire bound and change/segment count bounds cover encoding overhead.
func segmentChangeBytes(v SegmentChange) int64 {
	n := int64(len(v.Row.Table) + len(v.Row.Key) + len(v.Row.Operation) + len(v.Row.Image))
	if v.Row.Actor != nil {
		n += 16
	}
	if v.BeforeHash != nil {
		n += 64
	}
	return n
}
func appendSegmentChange(t *transcript, v SegmentChange) {
	c := v.Row
	t.s(c.Table)
	t.s(c.Key)
	t.s(c.Operation)
	t.b(c.Actor != nil)
	if c.Actor != nil {
		t.n(c.Actor.GitHubID)
		t.n(c.Actor.ProfileVersion)
	}
	t.b(v.BeforeHash != nil)
	if v.BeforeHash != nil {
		t.s(*v.BeforeHash)
	}
	t.n(int64(len(c.Image)))
	t.s(imageDigest(c.Image))
}

// SegmentHash excludes SealHash to avoid a cycle: the seal commits to the last
// segment hash. Source identity, journal and source commit boundary bind content.
func SegmentHash(m Manifest, s TransactionSegment) (string, int64, error) {
	if err := ValidateManifest(m); err != nil {
		return "", 0, err
	}
	if err := validateSegmentRows(m, s); err != nil {
		return "", 0, err
	}
	t := newTranscript("ghfind.feed.transfer.segment.v2")
	t.identity(m.Source)
	t.s(m.JournalID)
	t.n(s.Version)
	t.s(s.TransactionID)
	t.n(s.Sequence)
	t.s(s.PreviousCommitHash)
	t.n(s.Index)
	t.n(s.FirstOrdinal)
	t.s(s.PreviousSegmentHash)
	t.n(int64(len(s.Changes)))
	var count int64
	for _, c := range s.Changes {
		appendSegmentChange(t, c)
		count += segmentChangeBytes(c)
	}
	return t.sum(), count, nil
}
func SegmentedTransactionHash(m Manifest, s TransactionSeal) (string, error) {
	if err := ValidateManifest(m); err != nil {
		return "", err
	}
	if err := sealShape(m, s, DefaultSegmentQuota()); err != nil {
		return "", err
	}
	t := newTranscript("ghfind.feed.transfer.transaction.v2")
	t.identity(m.Source)
	t.s(m.JournalID)
	t.n(s.Version)
	t.s(s.TransactionID)
	t.n(s.Sequence)
	t.s(s.PreviousCommitHash)
	t.n(s.TotalChanges)
	t.n(s.ContentBytes)
	t.n(s.SegmentCount)
	t.s(s.LastSegmentHash)
	t.n(s.FloorRecords)
	t.s(s.FloorChainHash)
	return t.sum(), nil
}
func TransactionSealHash(m Manifest, s TransactionSeal) (string, error) {
	h, err := SegmentedTransactionHash(m, s)
	if err != nil {
		return "", err
	}
	if s.TransactionHash != h {
		return "", invalid("seg_transaction_hash")
	}
	t := newTranscript("ghfind.feed.transfer.seal.v2")
	t.n(s.Version)
	t.s(s.ManifestHash)
	t.s(h)
	return t.sum(), nil
}
func floorChain(previous string, c Change) string {
	t := newTranscript("ghfind.feed.transfer.floor-chain.v2")
	t.s(previous)
	t.s(c.Table)
	t.s(c.Key)
	t.n(c.Actor.GitHubID)
	t.n(c.Actor.ProfileVersion)
	return t.sum()
}
func progressHash(p StageProgress) string {
	t := newTranscript("ghfind.feed.transfer.stage-progress.v2")
	t.s(p.SealHash)
	t.n(p.NextSegment)
	t.n(p.NextOrdinal)
	t.n(p.ContentBytes)
	t.s(p.LastSegmentHash)
	t.b(p.LastRow != nil)
	if p.LastRow != nil {
		t.s(p.LastRow.Table)
		t.s(p.LastRow.Key)
		t.s(p.LastRow.Operation)
	}
	t.n(p.FloorRecords)
	t.s(p.FloorChainHash)
	t.b(p.Ready)
	return t.sum()
}
func stageReceiptHash(r DurableStageReceipt) string {
	t := newTranscript("ghfind.feed.transfer.stage-receipt.v2")
	t.n(r.Version)
	t.s(r.SealHash)
	t.n(r.SegmentIndex)
	t.s(r.SegmentHash)
	t.s(r.BeforeProgressHash)
	t.s(r.After.Hash)
	return t.sum()
}
func checkpointHash(c Checkpoint) (string, error) {
	if !digest(c.ManifestHash) || !safe(c.Sequence) || !digest(c.CommitHash) {
		return "", invalid("seg_checkpoint")
	}
	fh, err := DeletionFloorsHash(c.Floors)
	if err != nil {
		return "", err
	}
	t := newTranscript("ghfind.feed.transfer.applied-checkpoint.v2")
	t.s(c.ManifestHash)
	t.n(c.Sequence)
	t.s(c.CommitHash)
	t.s(fh)
	t.n(int64(len(c.Floors)))
	t.b(c.Final)
	return t.sum(), nil
}

// AtomicReceiptHash only computes integrity. Calling it cannot certify commit.
func AtomicReceiptHash(r AtomicCommitReceipt) (string, error) {
	if r.Version != SegmentedVersion {
		return "", invalid("unknown_version")
	}
	after, err := checkpointHash(r.After)
	if err != nil {
		return "", err
	}
	t := newTranscript("ghfind.feed.transfer.atomic-receipt.v2")
	t.n(r.Version)
	t.s(r.Outcome)
	t.s(r.SealHash)
	t.s(r.StageProgressHash)
	t.s(r.BeforeCheckpointHash)
	t.s(r.TransactionHash)
	t.s(r.FloorChainHash)
	t.s(r.DecisionHash)
	t.s(r.MapVersion)
	t.s(r.NormalizedStateHash)
	t.s(r.AtomicApplyID)
	t.s(after)
	return t.sum(), nil
}
func cursorFor(c Change) *ChangeCursor   { return &ChangeCursor{c.Table, c.Key, c.Operation} }
func cursorOrder(c *ChangeCursor) string { return c.Table + "\x00" + c.Key + "\x00" + c.Operation }
func canonicalTransactionID(m Manifest, sequence int64) string {
	return m.JournalID + ":" + strconv.FormatInt(sequence, 10)
}

// AppliedCheckpointHash is an integrity value for future authenticated ledgers,
// never proof that the supplied checkpoint actually committed.
func AppliedCheckpointHash(c Checkpoint) (string, error) { return checkpointHash(c) }
