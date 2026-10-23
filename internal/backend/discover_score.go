package backend

import "math"

// DiscoverScoreVersion mirrors platform/shared/discover-score.ts. The Go
// port computes only what the Feed projection shadow-writes (score, band,
// version); the TypeScript module stays the reference implementation and
// testdata/discover-score-golden.json pins both to the same outputs.
const DiscoverScoreVersion = "discover-score-v1.1"

// DiscoverScoreInput carries the artifact fields the score reads.
type DiscoverScoreInput struct {
	Pain              float64
	Effectiveness     float64
	Experience        float64
	ValueDensity      float64
	ProductScore      float64
	Confidence        float64
	VerificationLevel string
	Lifecycle         string
	ExposureBand      string
	// CommunityStrength is nil when unknown.
	CommunityStrength *float64
	Risks             []ProjectRisk
	Partition         string
	ProjectType       string
	TimeToFirstValue  string
}

// DiscoverScoreResult is the shadow-written subset of the TS result plus the
// try-gate value the internal tie-break uses.
type DiscoverScoreResult struct {
	Version            string  `json:"version"`
	Score              int     `json:"score"`
	Band               string  `json:"band"`
	Eligible           bool    `json:"eligible"`
	StrangerTryability float64 `json:"strangerTryability"`
}

type discoverWeights struct{ usefulness, tryability, focus, maturity, adoption float64 }

var discoverPartitionWeights = map[string]discoverWeights{
	"agent":        {0.4, 0.25, 0.1, 0.15, 0.1},
	"skill":        {0.35, 0.3, 0.2, 0.05, 0.1},
	"microservice": {0.35, 0.2, 0.1, 0.2, 0.15},
	"sandbox":      {0.45, 0.2, 0.1, 0.15, 0.1},
	"none":         {0.4, 0.25, 0.1, 0.15, 0.1},
}

var discoverLifecycleMaturity = map[string]float64{
	"stable_maintenance": 1, "feature_complete": 1, "active_evolution": 0.85, "experimental": 0.5, "abandoned": 0,
}

var discoverExposureAdoption = map[string]float64{
	"unknown": 0.5, "low": 0.35, "emerging": 0.6, "established": 0.9, "mainstream": 0.9,
}

var discoverCalibrationKnots = [][2]float64{{0, 0}, {35, 20}, {50, 40}, {58, 55}, {66, 70}, {76, 85}, {90, 97}, {100, 100}}

var discoverTTFVTryability = map[string]float64{"minutes": 1, "hour": 0.75, "day": 0.4, "weeks": 0.1}

var discoverProjectTypeReach = map[string]float64{
	"micro_tool": 1, "sdk_library": 1, "web_app": 1, "desktop_app": 1, "template_scaffold": 1,
	"framework_platform": 0.8, "database_infra": 0.7, "enterprise_system": 0.7,
}

var discoverCanonicalPartitionTags = map[string]string{
	"use_case:ai-agent":     "agent",
	"use_case:agent-skill":  "skill",
	"artifact:microservice": "microservice",
	"artifact:sandbox":      "sandbox",
}

const (
	discoverTryGateThreshold     = 0.7
	discoverTryGateThresholdMega = 0.8
	discoverMegaCommunity        = 80
	discoverMustTryCeiling       = 84
	discoverWeeksToValueCeiling  = 69
	discoverNotEligibleCeiling   = 24
)

// DiscoverScoreBand maps a displayed score to its band.
func DiscoverScoreBand(score int) string {
	switch {
	case score >= 85:
		return "must_try"
	case score >= 70:
		return "worth_a_look"
	case score >= 55:
		return "situational"
	case score >= 40:
		return "weak"
	default:
		return "skip"
	}
}

// DiscoverPartitionFromTags: only explicitly namespaced canonical tags count
// (legacy un-namespaced tags never set a partition, as in TS).
func DiscoverPartitionFromTags(tags []ProductTag) string {
	for _, tag := range tags {
		if !tag.NamespaceExplicit || tag.Namespace == "" {
			continue
		}
		if partition, ok := discoverCanonicalPartitionTags[tag.Namespace+":"+tag.Slug]; ok {
			return partition
		}
	}
	return "none"
}

// DiscoverScoreInputFromArtifact mirrors discoverScoreInputFromArtifact.
func DiscoverScoreInputFromArtifact(analysis *ProjectAnalysisArtifact) DiscoverScoreInput {
	community := analysis.CommunityStrength.Score
	var communityPtr *float64
	if !math.IsNaN(community) && !math.IsInf(community, 0) {
		communityPtr = &community
	}
	exposure := analysis.Exposure.Band
	if exposure == "" {
		exposure = "unknown"
	}
	projectType := ""
	if _, ok := discoverProjectTypeReach[analysis.Project.ProjectType]; ok {
		projectType = analysis.Project.ProjectType
	}
	ttfv := ""
	if _, ok := discoverTTFVTryability[analysis.Project.TimeToFirstValue]; ok {
		ttfv = analysis.Project.TimeToFirstValue
	}
	return DiscoverScoreInput{
		Pain:              float64(analysis.Scores.Pain.Score),
		Effectiveness:     float64(analysis.Scores.Effectiveness.Score),
		Experience:        float64(analysis.Scores.Experience.Score),
		ValueDensity:      float64(analysis.Scores.ValueDensity.Score),
		ProductScore:      float64(analysis.Scores.ProductScore),
		Confidence:        analysis.Confidence,
		VerificationLevel: analysis.VerificationLevel,
		Lifecycle:         analysis.Project.Lifecycle,
		ExposureBand:      exposure,
		CommunityStrength: communityPtr,
		Risks:             analysis.Risks,
		Partition:         DiscoverPartitionFromTags(analysis.Project.ProductTags),
		ProjectType:       projectType,
		TimeToFirstValue:  ttfv,
	}
}

// ComputeDiscoverScore mirrors computeDiscoverScore (score/band/eligibility).
func ComputeDiscoverScore(input DiscoverScoreInput) DiscoverScoreResult {
	pain := discoverRatio(input.Pain, 25)
	effectiveness := discoverRatio(input.Effectiveness, 30)
	experience := discoverRatio(input.Experience, 30)
	usefulness := 0.45*pain + 0.55*effectiveness
	tryability := experience
	if value, ok := discoverTTFVTryability[input.TimeToFirstValue]; ok {
		tryability = 0.5*experience + 0.5*value
	}
	focus := discoverRatio(input.ValueDensity, 15)
	maturity := discoverLifecycleMaturity[input.Lifecycle]
	communityTerm := 0.5
	if input.CommunityStrength != nil {
		communityTerm = math.Min(1, math.Sqrt(discoverClamp(*input.CommunityStrength, 0, 100)/70))
	}
	adoption := 0.6*communityTerm + 0.4*discoverExposureAdoption[input.ExposureBand]
	weights, ok := discoverPartitionWeights[input.Partition]
	if !ok {
		weights = discoverPartitionWeights["none"]
	}
	raw := 100 * (weights.usefulness*usefulness + weights.tryability*tryability + weights.focus*focus +
		weights.maturity*maturity + weights.adoption*adoption)
	shrink := discoverClamp(0.6+(discoverClamp(input.Confidence, 0, 100)-50)/75, 0.6, 1)
	shrunk := raw
	if raw > 50 {
		shrunk = 50 + (raw-50)*shrink
	}
	score := discoverCalibrate(shrunk)
	capAt := func(limit float64) { score = math.Min(score, limit) }
	if input.Lifecycle == "abandoned" {
		capAt(39)
	}
	if input.Lifecycle == "experimental" {
		capAt(69)
	}
	if input.VerificationLevel == "metadata_only" {
		capAt(54)
	}
	for _, risk := range input.Risks {
		if risk.Severity == "critical" {
			capAt(54)
			break
		}
	}
	if input.Partition == "sandbox" {
		for _, risk := range input.Risks {
			if risk.Category == "security" && risk.Severity == "high" {
				capAt(54)
				break
			}
		}
	}
	strangerTryability, threshold := discoverTryGate(input, experience)
	if input.TimeToFirstValue == "weeks" {
		capAt(discoverWeeksToValueCeiling)
	}
	if score >= 85 && strangerTryability < threshold {
		capAt(discoverMustTryCeiling)
	}
	eligible := input.Effectiveness >= 8 && input.Pain >= 7 && input.ProductScore >= 25
	if !eligible {
		capAt(discoverNotEligibleCeiling)
	}
	rounded := int(jsRound(discoverClamp(score, 0, 100)))
	return DiscoverScoreResult{
		Version:            DiscoverScoreVersion,
		Score:              rounded,
		Band:               DiscoverScoreBand(rounded),
		Eligible:           eligible,
		StrangerTryability: strangerTryability,
	}
}

func discoverTryGate(input DiscoverScoreInput, experience float64) (float64, float64) {
	community := 0.0
	if input.CommunityStrength != nil {
		community = *input.CommunityStrength
	}
	threshold := discoverTryGateThreshold
	if input.ExposureBand == "mainstream" || community >= discoverMegaCommunity {
		threshold = discoverTryGateThresholdMega
	}
	if value, ok := discoverTTFVTryability[input.TimeToFirstValue]; ok {
		return value, threshold
	}
	reach := 1.0
	if value, ok := discoverProjectTypeReach[input.ProjectType]; ok {
		reach = value
	}
	return jsRound(experience*reach*1000) / 1000, threshold
}

func discoverCalibrate(x float64) float64 {
	knots := discoverCalibrationKnots
	if x <= knots[0][0] {
		return knots[0][1]
	}
	for i := 1; i < len(knots); i++ {
		x0, y0, x1, y1 := knots[i-1][0], knots[i-1][1], knots[i][0], knots[i][1]
		if x <= x1 {
			return y0 + ((y1-y0)*(x-x0))/(x1-x0)
		}
	}
	return knots[len(knots)-1][1]
}

func discoverRatio(value, max float64) float64 { return discoverClamp(value, 0, max) / max }

func discoverClamp(value, min, max float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return min
	}
	return math.Min(max, math.Max(min, value))
}

// jsRound matches JavaScript Math.round (half rounds toward +Inf).
func jsRound(value float64) float64 { return math.Floor(value + 0.5) }
