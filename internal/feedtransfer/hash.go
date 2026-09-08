package feedtransfer

import (
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"strconv"
)

// Each token is framed as ASCII decimal UTF-8 byte length, ':', exact bytes.
// There is no delimiter after a token. Arrays include their length. Domain tags
// and field order are frozen in feed-transfer-v1.md and the shared fixture.
type transcript struct{ h hash.Hash }

func newTranscript(domain string) *transcript { t := &transcript{sha256.New()}; t.s(domain); return t }
func (t *transcript) s(v string) {
	t.h.Write([]byte(strconv.Itoa(len(v))))
	t.h.Write([]byte(":"))
	t.h.Write([]byte(v))
}
func (t *transcript) n(v int64) { t.s(strconv.FormatInt(v, 10)) }
func (t *transcript) b(v bool) {
	if v {
		t.s("1")
	} else {
		t.s("0")
	}
}
func (t *transcript) identity(v Identity) {
	t.s(v.Profile)
	t.s(v.ResourceID)
	t.n(v.Schema)
	t.n(v.WriterContract)
	t.n(v.WriterEpoch)
	t.n(v.RouteEpoch)
}
func (t *transcript) sum() string { return hex.EncodeToString(t.h.Sum(nil)) }
func imageDigest(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func ManifestHash(m Manifest) (string, error) {
	if err := ValidateManifest(m); err != nil {
		return "", err
	}
	t := newTranscript("ghfind.feed.transfer.manifest.v1")
	t.n(m.Version)
	t.s(m.Stream)
	t.s(m.MigrationID)
	t.s(m.JournalID)
	t.identity(m.Source)
	t.identity(m.Target)
	t.s(m.SnapshotSHA256)
	t.s(m.ArchiveInventorySHA256)
	t.n(m.ArchiveObjects)
	t.s(m.DeletionFloorsSHA256)
	t.n(m.DeletionFloorActors)
	t.n(m.FromSequence)
	t.n(m.ThroughSequence)
	t.s(m.AnchorHash)
	t.n(int64(len(m.Coverage)))
	for _, v := range m.Coverage {
		t.s(v.Table)
		t.s(v.Mode)
		t.s(v.Category)
		t.n(v.SnapshotRows)
	}
	return t.sum(), nil
}

// TransactionHash binds source identity and journal, independent of a target
// migration. Hash is excluded; all other fields, including order, are bound.
func TransactionHash(m Manifest, v Transaction) (string, error) {
	if err := ValidateManifest(m); err != nil {
		return "", err
	}
	if err := validateTransaction(m, v); err != nil {
		return "", err
	}
	t := newTranscript("ghfind.feed.transfer.transaction.v1")
	t.identity(m.Source)
	t.s(m.JournalID)
	t.n(v.Sequence)
	t.s(v.TransactionID)
	t.s(v.PreviousHash)
	t.n(int64(len(v.Changes)))
	for _, c := range v.Changes {
		t.s(c.Table)
		t.s(c.Key)
		t.s(c.Operation)
		t.b(c.Actor != nil)
		if c.Actor != nil {
			t.n(c.Actor.GitHubID)
			t.n(c.Actor.ProfileVersion)
		}
		t.n(int64(len(c.Image)))
		t.s(imageDigest(c.Image))
	}
	return t.sum(), nil
}
func BatchHash(v Batch) (string, error) {
	if v.Version != Version {
		return "", invalid("unknown_version")
	}
	if !digest(v.ManifestHash) || !digest(v.PreviousHash) || !safe(v.AfterSequence) || len(v.Transactions) > MaxTransactions {
		return "", invalid("batch_shape")
	}
	t := newTranscript("ghfind.feed.transfer.batch.v1")
	t.n(v.Version)
	t.s(v.ManifestHash)
	t.n(v.AfterSequence)
	t.s(v.PreviousHash)
	t.n(int64(len(v.Transactions)))
	for _, tx := range v.Transactions {
		if !digest(tx.Hash) {
			return "", invalid("transaction_hash")
		}
		t.s(tx.Hash)
	}
	t.b(v.Final)
	return t.sum(), nil
}

// DeletionFloorsHash binds a sorted, duplicate-free snapshot + later deletion
// overlay. The source must establish its completeness before closing a segment.
func DeletionFloorsHash(f []Floor) (string, error) {
	m, err := floorMap(f)
	if err != nil {
		return "", err
	}
	t := newTranscript("ghfind.feed.transfer.floors.v1")
	t.n(int64(len(m)))
	for _, v := range sortedFloors(m) {
		t.n(v.GitHubID)
		t.n(v.ProfileFloor)
	}
	return t.sum(), nil
}
