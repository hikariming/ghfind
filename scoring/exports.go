package scoring

// Exported helpers that the private collector/backend shares with the formula.
// They are thin aliases so the formula code keeps its original, reviewable
// shape; behaviour is defined by the unexported implementations.

func Max(values ...float64) float64                    { return max(values...) }
func Min(values ...float64) float64                    { return min(values...) }
func ValueOrZero(value *float64) float64               { return valueOrZero(value) }
func ValueOr(value *float64, fallback float64) float64 { return valueOr(value, fallback) }
func RoundJS(value float64) float64                    { return roundJS(value) }
func RoundToEven(value float64, digits int) float64    { return roundToEven(value, digits) }
func ClampScore(value float64) float64                 { return clampScore(value) }
func ClampUnit(value float64) float64                  { return clampUnit(value) }
func FormatNumber(value float64) string                { return formatNumber(value) }
func StarEngagementMultiplier(ratio *float64) float64  { return starEngagementMultiplier(ratio) }
func OriginalProjectQuality(m RawMetrics) float64      { return originalProjectQuality(m) }
func LowPrestigeBulkContributionCap(m RawMetrics) (float64, bool) {
	return lowPrestigeBulkContributionCap(m)
}
func PresentationDiscount(m RawMetrics) float64       { return presentationDiscount(m) }
func PRPresentationShare(pr RecentPR) (float64, bool) { return prPresentationShare(pr) }
func IsPresentationPath(path, repo string, docSite bool) bool {
	return isPresentationPath(path, repo, docSite)
}
func ApplyPresentationSignals(m *RawMetrics, prs []RecentPR, login string, ownRepos []string) {
	applyPresentationSignals(m, prs, login, ownRepos)
}

// TierFor is the LEGACY five-tier label still stored in Scoring.Tier. The
// current rating system is the 30–100 ladder in rating.go.
func TierFor(final float64) (string, string) { return tierFor(final) }
