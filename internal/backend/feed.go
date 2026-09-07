package backend

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"
)

const (
	FeedAlgorithmVersion = "baseline-v1"
	FeedSessionTTL       = 30 * time.Minute
	FeedImpressionTTL    = 24 * time.Hour
)

type FeedTag struct {
	ID              string  `json:"id"`
	Namespace       string  `json:"namespace"`
	Slug            string  `json:"slug"`
	LabelZH         string  `json:"labelZh"`
	LabelEN         string  `json:"labelEn"`
	Description     string  `json:"description,omitempty"`
	Weight          float64 `json:"weight,omitempty"`
	Confidence      float64 `json:"confidence,omitempty"`
	TaxonomyVersion int64   `json:"taxonomyVersion"`
}

type FeedProject struct {
	RepoKey           string    `json:"repoKey"`
	ItemID            string    `json:"-"`
	OwnerLogin        string    `json:"ownerLogin"`
	Name              string    `json:"name"`
	CanonicalURL      string    `json:"canonicalUrl"`
	Summary           string    `json:"summary"`
	Language          *string   `json:"language"`
	Topics            []string  `json:"topics"`
	ProjectType       string    `json:"projectType"`
	Lifecycle         string    `json:"lifecycle"`
	ProductScore      float64   `json:"productScore"`
	Confidence        float64   `json:"confidence"`
	VerificationLevel string    `json:"verificationLevel"`
	ExposureBand      string    `json:"exposureBand"`
	TreasureEligible  bool      `json:"treasureEligible"`
	ClassicEligible   bool      `json:"classicEligible"`
	AnalyzedAt        time.Time `json:"analyzedAt"`
	Publishable       bool      `json:"-"`
	Tags              []FeedTag `json:"tags"`
}

type FeedPreference struct {
	TagID           string  `json:"tagId"`
	Value           int     `json:"value"`
	Source          string  `json:"source"`
	Strength        float64 `json:"strength"`
	TaxonomyVersion int64   `json:"taxonomyVersion"`
}

type FeedUser struct {
	GitHubID            int64            `json:"githubId"`
	Login               string           `json:"login"`
	AvatarURL           string           `json:"avatarUrl,omitempty"`
	TaxonomyVersion     int64            `json:"taxonomyVersion"`
	ProfileVersion      int64            `json:"profileVersion"`
	Preferences         []FeedPreference `json:"preferences"`
	Embedding           []float64        `json:"-"`
	embeddingModel      string
	embeddingDimensions int
}

type FeedCandidate struct {
	Project            FeedProject
	Sources            []string
	TagAffinity        *float64
	SemanticSimilarity *float64
	Embedding          []float64
	SeenAt             *time.Time
	NotInterested      bool
}

type FeedFeatureSnapshot struct {
	TagAffinity        *float64 `json:"tagAffinity,omitempty"`
	SemanticSimilarity *float64 `json:"semanticSimilarity,omitempty"`
	ProductScore       float64  `json:"productScore"`
	Confidence         float64  `json:"confidence"`
	Freshness          float64  `json:"freshness"`
	DiscoveryBoost     float64  `json:"discoveryBoost"`
	MMRScore           float64  `json:"mmrScore"`
}

type FeedRankedItem struct {
	Project          FeedProject         `json:"project"`
	CandidateSources []string            `json:"-"`
	ReasonCodes      []string            `json:"reasonCodes"`
	Score            float64             `json:"-"`
	Rank             int                 `json:"-"`
	Exploration      bool                `json:"-"`
	Propensity       float64             `json:"-"`
	Features         FeedFeatureSnapshot `json:"-"`
	ImpressionToken  string              `json:"impressionToken,omitempty"`
}

type FeedSession struct {
	ID               string           `json:"id"`
	GitHubID         int64            `json:"githubId"`
	AlgorithmVersion string           `json:"algorithmVersion"`
	TaxonomyVersion  int64            `json:"taxonomyVersion"`
	ProfileVersion   int64            `json:"profileVersion"`
	PageSize         int              `json:"pageSize"`
	Seed             string           `json:"seed"`
	CandidateCounts  map[string]int   `json:"candidateCounts"`
	Degraded         []string         `json:"degraded"`
	Items            []FeedRankedItem `json:"items"`
	CreatedAt        time.Time        `json:"createdAt"`
	ExpiresAt        time.Time        `json:"expiresAt"`
}

type FeedEventType string

const (
	FeedEventImpression        FeedEventType = "impression"
	FeedEventDetailOpen        FeedEventType = "detail_open"
	FeedEventDwell             FeedEventType = "dwell"
	FeedEventGitHubOutbound    FeedEventType = "github_outbound"
	FeedEventShare             FeedEventType = "share"
	FeedEventSave              FeedEventType = "save"
	FeedEventUnsave            FeedEventType = "unsave"
	FeedEventNotInterested     FeedEventType = "not_interested"
	FeedEventUndoNotInterested FeedEventType = "undo_not_interested"
)

func (t FeedEventType) Valid() bool {
	switch t {
	case FeedEventImpression, FeedEventDetailOpen, FeedEventDwell, FeedEventGitHubOutbound, FeedEventShare,
		FeedEventSave, FeedEventUnsave, FeedEventNotInterested, FeedEventUndoNotInterested:
		return true
	default:
		return false
	}
}

func (t FeedEventType) Telemetry() bool {
	return t == FeedEventImpression || t == FeedEventDetailOpen || t == FeedEventDwell || t == FeedEventGitHubOutbound || t == FeedEventShare
}

type FeedEventInput struct {
	ID              string        `json:"id"`
	Type            FeedEventType `json:"type"`
	RepoKey         string        `json:"repoKey"`
	OccurredAt      time.Time     `json:"occurredAt"`
	ImpressionToken string        `json:"impressionToken"`
	DurationMS      int           `json:"durationMs,omitempty"`
}

func NewFeedID(prefix string) (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return strings.TrimSpace(prefix) + "_" + hex.EncodeToString(bytes), nil
}

func normalizeRepoKey(owner, repo string) string {
	return strings.ToLower(strings.TrimSpace(owner) + "/" + strings.TrimSpace(repo))
}
