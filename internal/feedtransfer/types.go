package feedtransfer

// All integers use the interoperable JSON-safe range. Commit sequences belong
// to this Feed journal, never the independent core assessment outbox.
const (
	Version               = 1
	MaxSafeInteger  int64 = 9007199254740991
	MaxBatchBytes         = 8 << 20
	MaxImageBytes         = 2 << 20
	MaxTransactions       = 32
	MaxChanges            = 512
	MaxBatchChanges       = 2048
	MaxFloorActors        = 100000
)

type Identity struct {
	Profile        string `json:"profile"`
	ResourceID     string `json:"resourceId"` // deployment-registered UUID, never a DSN
	Schema         int64  `json:"schema"`
	WriterContract int64  `json:"writerContract"`
	WriterEpoch    int64  `json:"writerEpoch"`
	RouteEpoch     int64  `json:"routeEpoch"`
}
type Coverage struct {
	Table        string `json:"table"`
	Mode         string `json:"mode"`
	Category     string `json:"category"`
	SnapshotRows int64  `json:"snapshotRows"`
}
type Manifest struct {
	Version                int64      `json:"version"`
	Stream                 string     `json:"stream"` // feed_transaction_journal, not a core/task outbox
	MigrationID            string     `json:"migrationId"`
	JournalID              string     `json:"journalId"`
	Source                 Identity   `json:"source"`
	Target                 Identity   `json:"target"`
	SnapshotSHA256         string     `json:"snapshotSha256"`
	ArchiveInventorySHA256 string     `json:"archiveInventorySha256"`
	ArchiveObjects         int64      `json:"archiveObjects"`
	DeletionFloorsSHA256   string     `json:"deletionFloorsSha256"`
	DeletionFloorActors    int64      `json:"deletionFloorActors"`
	FromSequence           int64      `json:"fromSequence"`    // snapshot includes this committed prefix
	ThroughSequence        int64      `json:"throughSequence"` // closed, externally established interval
	AnchorHash             string     `json:"anchorHash"`
	Coverage               []Coverage `json:"coverage"`
}
type ActorScope struct {
	GitHubID       int64 `json:"githubId"`
	ProfileVersion int64 `json:"profileVersion"`
}
type Change struct {
	Table     string      `json:"table"`
	Key       string      `json:"key"`       // opaque schema-mapper canonical business key; not SQL
	Operation string      `json:"operation"` // upsert, delete, erase, floor, command_tombstone
	Actor     *ActorScope `json:"actor"`     // explicit null for unscoped facts
	Image     []byte      `json:"image"`     // base64 UTF-8 JSON object after-image; no value logging
}
type Transaction struct {
	Sequence      int64    `json:"sequence"`
	TransactionID string   `json:"transactionId"`
	PreviousHash  string   `json:"previousHash"`
	Changes       []Change `json:"changes"` // complete atomic write set, never a page fragment
	Hash          string   `json:"hash"`
}
type Batch struct {
	Version       int64         `json:"version"`
	ManifestHash  string        `json:"manifestHash"`
	AfterSequence int64         `json:"afterSequence"`
	PreviousHash  string        `json:"previousHash"`
	Transactions  []Transaction `json:"transactions"`
	Final         bool          `json:"final"`
	Hash          string        `json:"hash"`
}

// Checkpoint/Receipt are caller-owned durable facts. Persist them atomically with
// the target transaction. The verifier cannot substitute memory for persistence.
type Floor struct {
	GitHubID     int64 `json:"githubId"`
	ProfileFloor int64 `json:"profileFloor"`
}
type Checkpoint struct {
	ManifestHash string  `json:"manifestHash"`
	Sequence     int64   `json:"sequence"`
	CommitHash   string  `json:"commitHash"`
	Floors       []Floor `json:"floors"`
	Final        bool    `json:"final"`
}
type Receipt struct {
	ManifestHash    string `json:"manifestHash"`
	AfterSequence   int64  `json:"afterSequence"`
	ThroughSequence int64  `json:"throughSequence"`
	BatchHash       string `json:"batchHash"`
}
type Decision struct {
	Sequence    int64
	ChangeIndex int
	Action      string // apply, suppress_deleted_generation, retain_max_floor, erase, tombstone
}
type Validation struct {
	Checkpoint       Checkpoint
	Receipt          Receipt
	Decisions        []Decision
	Duplicate        bool
	ProtocolComplete bool
	// These are ALWAYS false. External evidence and adapters do not exist here.
	CaptureConnected     bool
	RowSchemaValidated   bool
	ArchiveBytesVerified bool
	PromotionReady       bool
}

// Error intentionally contains only a fixed code. Keys, actors, row images and
// decoder errors must never be copied into public logs by this protocol layer.
type Error struct{ Code string }

func (e *Error) Error() string  { return "feed_transfer:" + e.Code }
func invalid(code string) error { return &Error{Code: code} }
