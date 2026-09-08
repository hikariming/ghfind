package backend

import (
	"context"
	"time"
)

// FeedSourceEvent is an immutable reference to one core transactional outbox
// row. The API caller cannot supply projection fields or publication authority.
type FeedSourceEvent struct {
	ContractVersion int    `json:"contractVersion"`
	EventID         string `json:"eventId"`
	AggregateKey    string `json:"aggregateKey"`
	SourceVersion   int64  `json:"sourceVersion"`
	Kind            string `json:"kind"`
	AnalysisID      string `json:"analysisId"`
	ReceiptID       string `json:"receiptId"`
	SourceHash      string `json:"sourceHash"`
	OccurredAt      int64  `json:"occurredAt"`
}
type FeedSubmissionReceipt struct {
	ReceiptID   string    `json:"receiptId"`
	SourceKind  string    `json:"sourceKind"`
	SubmittedAt time.Time `json:"submittedAt"`
}
type FeedSourceAssessment struct {
	RepoKey           string  `json:"repoKey"`
	LatestAnalysisID  string  `json:"latestAnalysisId"`
	ProductScore      float64 `json:"productScore"`
	Confidence        float64 `json:"confidence"`
	TreasureEligible  bool    `json:"treasureEligible"`
	ClassicEligible   bool    `json:"classicEligible"`
	ResolvedCommitSHA string  `json:"resolvedCommitSha"`
	AnalyzedAt        int64   `json:"analyzedAt"`
}

// Source capability: POST /internal/feed/source/v1/assessment, Bearer
// FEED_SOURCE_SECRET, X-Feed-Contract:1. Superseded status is valid only after
// verifying the exact historical outbox row and current newer source identity.
type FeedSourceResponse struct {
	EventID       string                 `json:"eventId"`
	SourceVersion int64                  `json:"sourceVersion"`
	Status        string                 `json:"status"`
	Assessment    *FeedSourceAssessment  `json:"assessment,omitempty"`
	AnalysisJSON  string                 `json:"analysisJSON,omitempty"`
	Overview      *ProjectOverview       `json:"overview,omitempty"`
	Receipt       *FeedSubmissionReceipt `json:"receipt,omitempty"`
}
type AssessmentSource interface {
	ReadFeedAssessment(context.Context, FeedSourceEvent) (FeedSourceResponse, error)
}

// jobs.claim creates/claims an immutable event identity. Same eventId with any
// changed envelope fails 409. Lease90s; at most8 attempts. Expired final leases
// persist dead_letter. busy/dead_letter do not acknowledge Queue delivery.
type FeedJobClaimRequest struct {
	WriterEpoch  int64           `json:"writerEpoch"`
	Event        FeedSourceEvent `json:"event"`
	LeaseOwner   string          `json:"leaseOwner"`
	LeaseSeconds int             `json:"leaseSeconds"`
}
type FeedJobClaimResponse struct {
	Status     string     `json:"status"`
	Attempts   int        `json:"attempts"`
	LeaseUntil *time.Time `json:"leaseUntil,omitempty"`
}

// complete/fail must require the matching unexpired lease. fail keeps an error
// code (no secrets/body), finite backoff max300s, then dead_letter at attempt8.
type FeedJobFinishRequest struct {
	WriterEpoch int64  `json:"writerEpoch"`
	EventID     string `json:"eventId"`
	LeaseOwner  string `json:"leaseOwner"`
	ErrorCode   string `json:"errorCode,omitempty"`
}
type FeedJobStore interface {
	ClaimFeedJob(context.Context, FeedJobClaimRequest) (FeedJobClaimResponse, error)
	CompleteFeedJob(context.Context, FeedJobFinishRequest) error
	FailFeedJob(context.Context, FeedJobFinishRequest) error
}
type FeedProjectionProductTag struct {
	Namespace         string           `json:"namespace"`
	NamespaceExplicit bool             `json:"namespaceExplicit"`
	Slug              string           `json:"slug"`
	Labels            ProductTagLabels `json:"labels"`
	EvidenceIDs       []string         `json:"evidenceIds"`
}

// Explicit internal projection fields (all lowerCamel) are the projector result.
// ProductTags keeps namespaceExplicit, which is hidden in the public artifact.
type FeedProjectionDTO struct {
	FeedProjectProjection
	ProductTags []FeedProjectionProductTag `json:"productTags"`
}

// projection.apply atomically writes project, tag provenance, receipt and
// monotonic sourceVersion. It verifies job lease, writer epoch and repo/event
// identity; old versions return duplicate=true without replacing any fields.
type FeedApplyProjectionRequest struct {
	WriterEpoch   int64                 `json:"writerEpoch"`
	EventID       string                `json:"eventId"`
	LeaseOwner    string                `json:"leaseOwner"`
	SourceVersion int64                 `json:"sourceVersion"`
	Projection    FeedProjectionDTO     `json:"projection"`
	Receipt       FeedSubmissionReceipt `json:"receipt"`
}
type FeedApplyProjectionResponse struct {
	Duplicate bool `json:"duplicate"`
}
type FeedCatalogProjectionStore interface {
	ApplyFeedProjection(context.Context, FeedApplyProjectionRequest) (FeedApplyProjectionResponse, error)
}
