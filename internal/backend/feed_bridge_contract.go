package backend

import "time"

// FeedBridgeVersion versions the private capability protocol, never the public
// /api/feed response. All operations are POST /internal/feed/v1/{operation},
// authenticated with Authorization: Bearer <FEED_BRIDGE_SECRET> and
// X-Feed-Contract: 1. Errors are {"error":"code"}; unsupported operations fail.
// Times use RFC3339 UTC. JSON numbers representing IDs must be safe integers.
const FeedBridgeVersion = "1"

// Every mutation atomically verifies the active writer epoch. Profile mutations
// additionally compare expectedProfileVersion, a monotonic generation that must
// never reset when a deleted actor creates a new profile. Zero is permitted only
// when creating/ensuring a user or deleting an already-absent profile.
type FeedMutationFence struct {
	WriterEpoch            int64 `json:"writerEpoch"`
	ExpectedProfileVersion int64 `json:"expectedProfileVersion"`
}

// Private DTOs are intentionally separate from public structs with json:"-".
// Losing rank or features on a cache round-trip corrupts attribution.
type FeedProjectDTO struct {
	FeedProject
	ItemID             string `json:"itemId"`
	Publishable        bool   `json:"publishable"`
	SubmissionEvidence bool   `json:"submissionEvidence"`
}
type FeedUserDTO struct {
	FeedUser
	Embedding           []float64 `json:"embedding,omitempty"`
	EmbeddingModel      string    `json:"embeddingModel,omitempty"`
	EmbeddingDimensions int       `json:"embeddingDimensions,omitempty"`
}
type FeedCandidateDTO struct {
	Project            FeedProjectDTO `json:"project"`
	Sources            []string       `json:"sources"`
	TagAffinity        *float64       `json:"tagAffinity"`
	SemanticSimilarity *float64       `json:"semanticSimilarity"`
	Embedding          []float64      `json:"embedding,omitempty"`
	SeenAt             *time.Time     `json:"seenAt"`
	NotInterested      bool           `json:"notInterested"`
}
type FeedRankedItemDTO struct {
	Project          FeedProjectDTO      `json:"project"`
	CandidateSources []string            `json:"candidateSources"`
	ReasonCodes      []string            `json:"reasonCodes"`
	Score            float64             `json:"score"`
	Rank             int                 `json:"rank"`
	Exploration      bool                `json:"exploration"`
	Propensity       float64             `json:"propensity"`
	Features         FeedFeatureSnapshot `json:"features"`
}
type FeedSessionDTO struct {
	ID               string              `json:"id"`
	GitHubID         int64               `json:"githubId"`
	AlgorithmVersion string              `json:"algorithmVersion"`
	TaxonomyVersion  int64               `json:"taxonomyVersion"`
	ProfileVersion   int64               `json:"profileVersion"`
	PageSize         int                 `json:"pageSize"`
	Seed             string              `json:"seed"`
	CandidateCounts  map[string]int      `json:"candidateCounts"`
	Degraded         []string            `json:"degraded"`
	Items            []FeedRankedItemDTO `json:"items"`
	CreatedAt        time.Time           `json:"createdAt"`
	ExpiresAt        time.Time           `json:"expiresAt"`
}

// health: {} -> FeedBridgeHealthResponse. Must probe schema and bindings.
type FeedBridgeHealthResponse struct {
	WriterEpoch     int64  `json:"writerEpoch"`
	WritesEnabled   bool   `json:"writesEnabled"`
	Ready           bool   `json:"ready"`
	ContractVersion string `json:"contractVersion"`
}

// taxonomy.list: {} -> FeedBridgeTagsResponse.
type FeedBridgeTagsResponse struct {
	Tags            []FeedTag `json:"tags"`
	TaxonomyVersion int64     `json:"taxonomyVersion"`
}

// users.ensure: FeedBridgeEnsureUserRequest -> FeedBridgeUserResponse.
type FeedBridgeEnsureUserRequest struct {
	FeedMutationFence
	GitHubID  int64  `json:"githubId"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

// users.get: FeedBridgeUserRequest -> FeedBridgeUserResponse (user:null if absent).
type FeedBridgeUserRequest struct {
	GitHubID int64 `json:"githubId"`
}
type FeedBridgeUserResponse struct {
	User *FeedUserDTO `json:"user"`
}

// preferences.replace: atomic preferences + profile version + associated outbox.
// taxonomy conflict is HTTP 409 {"error":"taxonomy_version_changed"}.
type FeedBridgePreferencesRequest struct {
	FeedMutationFence
	GitHubID        int64            `json:"githubId"`
	TaxonomyVersion int64            `json:"taxonomyVersion"`
	Preferences     []FeedPreference `json:"preferences"`
}

// candidates.load: separate bounded tag=80/latest=40/quality=20/longTail=20
// recalls, hard filters, then merge. Trust stored user state, not supplied scores.
type FeedBridgeCandidatesRequest struct {
	GitHubID int64 `json:"githubId"`
	Limit    int   `json:"limit"`
}
type FeedBridgeCandidatesResponse struct {
	Candidates []FeedCandidateDTO `json:"candidates"`
	Counts     map[string]int     `json:"counts"`
}

// projects.available rechecks publication/provenance/negative state, NOT seenAt,
// so impressions received between pages cannot invalidate the saved sequence.
type FeedBridgeAvailableRequest struct {
	GitHubID int64    `json:"githubId"`
	RepoKeys []string `json:"repoKeys"`
}
type FeedBridgeAvailableResponse struct {
	Available map[string]bool `json:"available"`
}

// requests.save atomically inserts request and every served item. Existing ID
// with a different payload is a conflict; exact retries are safe.
type FeedBridgeSaveRequest struct {
	FeedMutationFence
	AlgorithmVersion string              `json:"algorithmVersion,omitempty"`
	PayloadHash      string              `json:"payloadHash"`
	ID               string              `json:"id"`
	User             FeedUserDTO         `json:"user"`
	Seed             string              `json:"seed"`
	CandidateCounts  map[string]int      `json:"candidateCounts"`
	Degraded         []string            `json:"degraded"`
	DurationMS       int64               `json:"durationMs"`
	Items            []FeedRankedItemDTO `json:"items"`
}

// state.set: atomic state + deduped event + profile version + outbox. Requires
// requestId belonging to this actor and repo. Exactly one bool is present.
type FeedBridgeStateRequest struct {
	FeedMutationFence
	GitHubID      int64     `json:"githubId"`
	RepoKey       string    `json:"repoKey"`
	RequestID     string    `json:"requestId"`
	Saved         *bool     `json:"saved,omitempty"`
	NotInterested *bool     `json:"notInterested,omitempty"`
	Now           time.Time `json:"now"`
}

// events.append uses typed, server-validated metadata; no arbitrary user JSON.
type FeedAcceptedEventDTO struct {
	Input     FeedEventInput       `json:"input"`
	RequestID string               `json:"requestId"`
	Metadata  FeedEventMetadataDTO `json:"metadata"`
}
type FeedEventMetadataDTO struct {
	Rank             int    `json:"rank"`
	AlgorithmVersion string `json:"algorithmVersion"`
	DurationMS       int    `json:"durationMs,omitempty"`
	Qualified        bool   `json:"qualified,omitempty"`
}
type FeedBridgeEventsRequest struct {
	FeedMutationFence
	GitHubID int64                  `json:"githubId"`
	Events   []FeedAcceptedEventDTO `json:"events"`
}

// profile.delete immediately fences old sessions/tokens and durably queues cleanup.
type FeedBridgeDeleteRequest struct {
	FeedMutationFence
	GitHubID int64     `json:"githubId"`
	Now      time.Time `json:"now"`
}
type FeedBridgeDeleteResponse struct {
	DeletionID string `json:"deletionId"`
	Status     string `json:"status"`
}

// profile.deletion.get is user scoped; unknown/cross-user ID returns 404.
type FeedBridgeDeletionRequest struct {
	GitHubID   int64  `json:"githubId"`
	DeletionID string `json:"deletionId"`
}

// sessions.put: {session,...fence}, sessions.get/delete: {id,githubId,...fence}. put checks user's profile
// version and expiresAt<=createdAt+30min. get returns 404 session_not_found.
type FeedBridgePutSessionRequest struct {
	FeedMutationFence
	Session FeedSessionDTO `json:"session"`
}
type FeedBridgeSessionRequest struct {
	FeedMutationFence
	GitHubID int64  `json:"githubId"`
	ID       string `json:"id"`
}
type FeedBridgeSessionResponse struct {
	Session FeedSessionDTO `json:"session"`
}

// Successful void writes return {"ok":true}.
type FeedBridgeOK struct {
	OK bool `json:"ok"`
}
