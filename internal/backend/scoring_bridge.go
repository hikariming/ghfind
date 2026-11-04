package backend

// Bridge to the public scoring module (github.com/hikariming/ghfind/scoring).
// The formula, risk rules, rating ladder and the evidence types they read are
// owned there; the backend keeps its historical names through aliases so call
// sites and JSON wire formats are unchanged.

import "github.com/hikariming/ghfind/scoring"

type (
	RawMetrics     = scoring.RawMetrics
	SubScores      = scoring.SubScores
	Scoring        = scoring.Scoring
	RedFlag        = scoring.RedFlag
	RiskEvidence   = scoring.RiskEvidence
	RiskSignal     = scoring.RiskSignal
	RiskCoverage   = scoring.RiskCoverage
	RiskAssessment = scoring.RiskAssessment
	RecentPR       = scoring.RecentPR
	PRFileChange   = scoring.PRFileChange
	ImpactRepo     = scoring.ImpactRepo
)

func Score(m RawMetrics) Scoring { return scoring.Score(m) }
func AssessRisk(m RawMetrics) (RiskAssessment, []RiskSignal, []RedFlag, float64) {
	return scoring.AssessRisk(m)
}
func SpamBotScore(m RawMetrics) float64           { return scoring.SpamBotScore(m) }
func LogRatio(value, fullAt float64) float64      { return scoring.LogRatio(value, fullAt) }
func SmoothedRate(events, sample float64) float64 { return scoring.SmoothedRate(events, sample) }
func WilsonLower(rejected, decided, z float64) float64 {
	return scoring.WilsonLower(rejected, decided, z)
}

func max(values ...float64) float64                    { return scoring.Max(values...) }
func min(values ...float64) float64                    { return scoring.Min(values...) }
func valueOrZero(value *float64) float64               { return scoring.ValueOrZero(value) }
func valueOr(value *float64, fallback float64) float64 { return scoring.ValueOr(value, fallback) }
func roundJS(value float64) float64                    { return scoring.RoundJS(value) }
func roundToEven(value float64, digits int) float64    { return scoring.RoundToEven(value, digits) }
func clampScore(value float64) float64                 { return scoring.ClampScore(value) }
func clampUnit(value float64) float64                  { return scoring.ClampUnit(value) }
func formatNumber(value float64) string                { return scoring.FormatNumber(value) }
func starEngagementMultiplier(ratio *float64) float64  { return scoring.StarEngagementMultiplier(ratio) }
func originalProjectQuality(m RawMetrics) float64      { return scoring.OriginalProjectQuality(m) }
func lowPrestigeBulkContributionCap(m RawMetrics) (float64, bool) {
	return scoring.LowPrestigeBulkContributionCap(m)
}
func presentationDiscount(m RawMetrics) float64       { return scoring.PresentationDiscount(m) }
func prPresentationShare(pr RecentPR) (float64, bool) { return scoring.PRPresentationShare(pr) }
func isPresentationPath(path, repo string, docSite bool) bool {
	return scoring.IsPresentationPath(path, repo, docSite)
}
func applyPresentationSignals(m *RawMetrics, prs []RecentPR, login string, ownRepos []string) {
	scoring.ApplyPresentationSignals(m, prs, login, ownRepos)
}

// tierFor is the legacy five-tier label; see scoring.TierFor.
func tierFor(final float64) (string, string) { return scoring.TierFor(final) }
