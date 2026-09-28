package feedtransfer

// SegmentedVersion is an independent envelope. All v1 types, bytes and hashes
// remain unchanged. This package still has no capture, staging DB or apply DB.
const SegmentedVersion = 2

// Quota is a caller-approved reservation, bounded by these protocol ceilings.
// Limits are checked against the seal before accepting any content.
type SegmentQuota struct {
	MaxChanges      int64 `json:"maxChanges"`
	MaxContentBytes int64 `json:"maxContentBytes"`
	MaxSegments     int64 `json:"maxSegments"`
}

func DefaultSegmentQuota() SegmentQuota { return SegmentQuota{1000000, 256 << 20, 2048} }

type TransactionSeal struct {
	Version            int64  `json:"version"`
	ManifestHash       string `json:"manifestHash"`
	TransactionID      string `json:"transactionId"`
	Sequence           int64  `json:"sequence"`
	PreviousCommitHash string `json:"previousCommitHash"`
	TotalChanges       int64  `json:"totalChanges"`
	ContentBytes       int64  `json:"contentBytes"`
	SegmentCount       int64  `json:"segmentCount"`
	LastSegmentHash    string `json:"lastSegmentHash"`
	FloorRecords       int64  `json:"floorRecords"`
	FloorChainHash     string `json:"floorChainHash"`
	TransactionHash    string `json:"transactionHash"`
	Hash               string `json:"hash"`
}
type SegmentChange struct {
	Row        Change  `json:"row"`
	BeforeHash *string `json:"beforeHash"` // source row digest, null for insertion/floor metadata
}
type TransactionSegment struct {
	Version             int64           `json:"version"`
	SealHash            string          `json:"sealHash"`
	TransactionID       string          `json:"transactionId"`
	Sequence            int64           `json:"sequence"`
	PreviousCommitHash  string          `json:"previousCommitHash"`
	Index               int64           `json:"index"`
	FirstOrdinal        int64           `json:"firstOrdinal"`
	PreviousSegmentHash string          `json:"previousSegmentHash"`
	Changes             []SegmentChange `json:"changes"`
	Hash                string          `json:"hash"`
}
type ChangeCursor struct {
	Table     string `json:"table"`
	Key       string `json:"key"`
	Operation string `json:"operation"`
}

// StageProgress contains no row images, keys inventory, or per-change tree.
// Only the last ordering cursor is retained. It never advances a Feed commit.
type StageProgress struct {
	SealHash        string        `json:"sealHash"`
	NextSegment     int64         `json:"nextSegment"`
	NextOrdinal     int64         `json:"nextOrdinal"`
	ContentBytes    int64         `json:"contentBytes"`
	LastSegmentHash string        `json:"lastSegmentHash"`
	LastRow         *ChangeCursor `json:"lastRow"`
	FloorRecords    int64         `json:"floorRecords"`
	FloorChainHash  string        `json:"floorChainHash"`
	Ready           bool          `json:"ready"`
	Hash            string        `json:"hash"`
}

// DurableStageReceipt MUST be loaded from authenticated durable staging storage.
// Hashes authenticate no caller. A computed receipt is a persistence proposal.
type DurableStageReceipt struct {
	Version            int64         `json:"version"`
	SealHash           string        `json:"sealHash"`
	SegmentIndex       int64         `json:"segmentIndex"`
	SegmentHash        string        `json:"segmentHash"`
	BeforeProgressHash string        `json:"beforeProgressHash"`
	After              StageProgress `json:"after"`
	Hash               string        `json:"hash"`
}
type StagingProposal struct {
	Progress               StageProgress
	Receipt                DurableStageReceipt
	Duplicate              bool
	ContentComplete        bool
	CaptureConnected       bool
	DurableStorageVerified bool
	PromotionReady         bool
}

// AtomicCommitReceipt is issued ONLY by the future target apply transaction.
// No API here creates one. Pass only a receipt loaded from a trusted target
// ledger, never a network client's assertion that a transaction was committed.
type AtomicCommitReceipt struct {
	Version              int64      `json:"version"`
	Outcome              string     `json:"outcome"` // applied
	SealHash             string     `json:"sealHash"`
	StageProgressHash    string     `json:"stageProgressHash"`
	BeforeCheckpointHash string     `json:"beforeCheckpointHash"`
	TransactionHash      string     `json:"transactionHash"`
	FloorChainHash       string     `json:"floorChainHash"`
	DecisionHash         string     `json:"decisionHash"`
	MapVersion           string     `json:"mapVersion"`
	NormalizedStateHash  string     `json:"normalizedStateHash"`
	AtomicApplyID        string     `json:"atomicApplyId"`
	After                Checkpoint `json:"after"`
	Hash                 string     `json:"hash"`
}
type AppliedHead struct {
	Checkpoint        Checkpoint `json:"checkpoint"`
	AtomicReceiptHash string     `json:"atomicReceiptHash"`
}
type StagedSemantics struct {
	DecisionHash string
	TotalChanges int64
	Suppressed   int64
}
type AdvanceProposal struct {
	AtomicReceiptHash         string
	Duplicate                 bool
	Checkpoint                Checkpoint
	AtomicReceiptMatched      bool
	CaptureConnected          bool
	AtomicApplicationVerified bool
	RowSchemaValidated        bool
	PromotionReady            bool
}
