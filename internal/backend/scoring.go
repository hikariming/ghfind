package backend

import (
	"fmt"
	"math"
)

// RawMetrics is the wire contract used by the existing Node collector and the
// Go scoring engine. Optional fields deliberately use pointers: absent values
// have established, conservative fallback behaviour in the published rubric.
// Fields that are optional (`?`) in src/lib/types.ts carry `omitempty`: the
// Node scorer treats `undefined` as "unmeasured" but `null` as a real value
// (e.g. `top_repo_engagement_ratio === undefined` skips the star-engagement
// penalty), so a nil pointer must omit the key entirely rather than write an
// explicit null. Fields typed `| null` on the Node side keep explicit nulls.
// Do not change this formula without changing src/lib/score.ts and its shared
// regression fixtures in the same review.
type RawMetrics struct {
	// Factual score-owner identity; excluded from scoring formulas.
	GitHubUserID                        *string            `json:"github_user_id,omitempty"`
	PersonalOriginalProjectQualityScore *float64           `json:"personal_original_project_quality_score,omitempty"`
	AttributedOriginalRepoShares        map[string]float64 `json:"attributed_original_repo_shares,omitempty"`
	PresentationCoreChurnShare          *float64           `json:"presentation_core_churn_share,omitempty"`
	PresentationChurnShare              *float64           `json:"presentation_churn_share,omitempty"`
	PresentationRepoConcentration       *float64           `json:"presentation_repo_concentration,omitempty"`
	PresentationPRSample                *float64           `json:"presentation_pr_sample,omitempty"`
	PresentationCorePRCount             *float64           `json:"presentation_core_pr_count,omitempty"`
	// Explicit profile pronouns are writer context only; Score never uses them.
	Pronouns                           *string  `json:"pronouns,omitempty"`
	Username                           string   `json:"username"`
	ProfileURL                         *string  `json:"profile_url"`
	AvatarURL                          *string  `json:"avatar_url"`
	Name                               *string  `json:"name"`
	Bio                                *string  `json:"bio"`
	Company                            *string  `json:"company"`
	AccountAgeYears                    float64  `json:"account_age_years"`
	CreatedAt                          *string  `json:"created_at"`
	Followers                          float64  `json:"followers"`
	Following                          float64  `json:"following"`
	PublicRepos                        float64  `json:"public_repos"`
	FetchedRepoCount                   float64  `json:"fetched_repo_count"`
	OriginalRepoCount                  float64  `json:"original_repo_count"`
	NonemptyOriginalRepoCount          float64  `json:"nonempty_original_repo_count"`
	ForkRepoCount                      float64  `json:"fork_repo_count"`
	EmptyOriginalRepoCount             float64  `json:"empty_original_repo_count"`
	TotalStars                         float64  `json:"total_stars"`
	MaxStars                           float64  `json:"max_stars"`
	ContentSkillStarShare              *float64 `json:"content_skill_star_share,omitempty"`
	ContentSkillConfidence             *float64 `json:"content_skill_confidence,omitempty"`
	WeightedTotalStars                 *float64 `json:"weighted_total_stars,omitempty"`
	WeightedMaxStars                   *float64 `json:"weighted_max_stars,omitempty"`
	TopRepoEngagementRatio             *float64 `json:"top_repo_engagement_ratio,omitempty"`
	AttributedOriginalRepoCount        *float64 `json:"attributed_original_repo_count,omitempty"`
	AttributedOriginalRepoStars        *float64 `json:"attributed_original_repo_stars,omitempty"`
	AttributedOriginalRepos            []string `json:"attributed_original_repos,omitempty"`
	BestOriginalRepoQualityScore       *float64 `json:"best_original_repo_quality_score,omitempty"`
	BestOriginalRepoQualityRepo        *string  `json:"best_original_repo_quality_repo,omitempty"`
	TopStarredOriginalRepoQualityScore *float64 `json:"top_starred_original_repo_quality_score,omitempty"`
	TopStarredOriginalRepoQualityRepo  *string  `json:"top_starred_original_repo_quality_repo,omitempty"`
	MergedPRCount                      float64  `json:"merged_pr_count"`
	ExternalMergedPRCount              *float64 `json:"external_merged_pr_count,omitempty"`
	ExternalHighStarPRShare            *float64 `json:"external_high_star_pr_share,omitempty"`
	OwnPRCommunity                     *float64 `json:"own_pr_community,omitempty"`
	WorkflowLandedPRCount              *float64 `json:"workflow_landed_pr_count,omitempty"`
	TotalPRCount                       float64  `json:"total_pr_count"`
	IssuesCreated                      float64  `json:"issues_created"`
	LastYearContributions              float64  `json:"last_year_contributions"`
	ActivityTypeCount                  float64  `json:"activity_type_count"`
	ContributionYearsActive            float64  `json:"contribution_years_active"`
	DaysSinceLastActivity              *float64 `json:"days_since_last_activity"`
	RecentMergedPRSample               float64  `json:"recent_merged_pr_sample"`
	RecentTrivialPRCount               float64  `json:"recent_trivial_pr_count"`
	RecentDocLikePRCount               *float64 `json:"recent_doc_like_pr_count,omitempty"`
	RecentDocLikePRRatio               *float64 `json:"recent_doc_like_pr_ratio,omitempty"`
	RecentExternalPRSample             *float64 `json:"recent_external_pr_sample,omitempty"`
	RecentExternalDocLikePRCount       *float64 `json:"recent_external_doc_like_pr_count,omitempty"`
	RecentExternalDocLikePRRatio       *float64 `json:"recent_external_doc_like_pr_ratio,omitempty"`
	ExternalTrivialPRCount             float64  `json:"external_trivial_pr_count"`
	MaxImpactRepoStars                 float64  `json:"max_impact_repo_stars"`
	ImpactPrestigeScore                *float64 `json:"impact_prestige_score,omitempty"`
	ImpactPRCount                      float64  `json:"impact_pr_count"`
	WorkflowLandedImpactPRCount        *float64 `json:"workflow_landed_impact_pr_count,omitempty"`
	ImpactDepthRaw                     float64  `json:"impact_depth_raw"`
	// ImpactQualityCap is legacy: no longer produced or scored (per-repo code
	// share replaced it), kept so older snapshots round-trip.
	ImpactQualityCap                          *float64     `json:"impact_quality_cap,omitempty"`
	VerifiedImpactPRCount                     *float64     `json:"verified_impact_pr_count,omitempty"`
	CoreImpactPRCount                         *float64     `json:"core_impact_pr_count,omitempty"`
	DocLikeImpactPRCount                      *float64     `json:"doc_like_impact_pr_count,omitempty"`
	UnverifiedImpactPRCount                   *float64     `json:"unverified_impact_pr_count,omitempty"`
	ImpactRepoCount                           *float64     `json:"impact_repo_count,omitempty"`
	ImpactRepos                               []ImpactRepo `json:"impact_repos,omitempty"`
	ImpactCommitCount                         *float64     `json:"impact_commit_count,omitempty"`
	CommitContributionAggregationUnavailable  bool         `json:"commit_contribution_aggregation_unavailable"`
	MergedPRContributionAggregationIncomplete bool         `json:"merged_pr_contribution_aggregation_incomplete"`
	StarInflationSuspect                      bool         `json:"star_inflation_suspect"`
	ClosedUnmergedPRCount                     float64      `json:"closed_unmerged_pr_count"`
	MaintainerClosedUnmergedPRCount           *float64     `json:"maintainer_closed_unmerged_pr_count,omitempty"`
	SelfClosedExternalPRCount                 *float64     `json:"self_closed_external_pr_count,omitempty"`
	SelfClosedOwnRepoPRCount                  *float64     `json:"self_closed_own_repo_pr_count,omitempty"`
	UnknownClosedUnmergedPRCount              *float64     `json:"unknown_closed_unmerged_pr_count,omitempty"`
	PRRejectionRate                           float64      `json:"pr_rejection_rate"`
	RecentPRSample                            float64      `json:"recent_pr_sample"`
	TopRepoPRTarget                           *string      `json:"top_repo_pr_target"`
	TopRepoPRShare                            float64      `json:"top_repo_pr_share"`
	TemplatedPRRatio                          float64      `json:"templated_pr_ratio"`
	PRFloodSuspect                            bool         `json:"pr_flood_suspect"`
}

type SubScores struct {
	AccountMaturity        float64 `json:"account_maturity"`
	OriginalProjectQuality float64 `json:"original_project_quality"`
	ContributionQuality    float64 `json:"contribution_quality"`
	EcosystemImpact        float64 `json:"ecosystem_impact"`
	CommunityInfluence     float64 `json:"community_influence"`
	ActivityAuthenticity   float64 `json:"activity_authenticity"`
}

type RedFlag struct {
	Flag    string  `json:"flag"`
	Penalty float64 `json:"penalty"`
	Detail  string  `json:"detail"`
}

type RiskEvidence struct {
	Observed   map[string]any     `json:"observed"`
	SampleSize *float64           `json:"sample_size,omitempty"`
	Threshold  map[string]float64 `json:"threshold,omitempty"`
	Coverage   map[string]float64 `json:"coverage"`
	Window     string             `json:"window"`
}

type RiskSignal struct {
	Flag        string       `json:"flag"`
	Family      string       `json:"family"`
	Disposition string       `json:"disposition"`
	Severity    float64      `json:"severity"`
	Confidence  float64      `json:"confidence"`
	Penalty     float64      `json:"penalty"`
	Detail      string       `json:"detail"`
	Evidence    RiskEvidence `json:"evidence"`
}

type RiskCoverage struct {
	Repo     float64 `json:"repo"`
	MergedPR float64 `json:"merged_pr"`
	AllPR    float64 `json:"all_pr"`
}

type RiskAssessment struct {
	Version        string       `json:"version"`
	RiskScore      float64      `json:"risk_score"`
	Level          string       `json:"level"`
	Confidence     float64      `json:"confidence"`
	AppliedPenalty float64      `json:"applied_penalty"`
	Signals        []RiskSignal `json:"signals"`
	Coverage       RiskCoverage `json:"coverage"`
}

type Scoring struct {
	SubScores      SubScores      `json:"sub_scores"`
	BaseScore      float64        `json:"base_score"`
	RedFlags       []RedFlag      `json:"red_flags"`
	RiskAssessment RiskAssessment `json:"risk_assessment"`
	RiskNotes      []RiskSignal   `json:"risk_notes"`
	TotalPenalty   float64        `json:"total_penalty"`
	FinalScore     float64        `json:"final_score"`
	Tier           string         `json:"tier"`
	TierLabel      string         `json:"tier_label"`
}

func valueOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func valueOr(value *float64, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return *value
}

func min(values ...float64) float64 {
	if len(values) == 0 {
		return 0
	}
	result := values[0]
	for _, value := range values[1:] {
		if value < result {
			result = value
		}
	}
	return result
}

func max(values ...float64) float64 {
	if len(values) == 0 {
		return 0
	}
	result := values[0]
	for _, value := range values[1:] {
		if value > result {
			result = value
		}
	}
	return result
}

// roundToEven matches the TypeScript scorer's explicit Python-compatible
// half-to-even rule, including the epsilon used around binary .5 boundaries.
func roundToEven(value float64, digits int) float64 {
	factor := math.Pow(10, float64(digits))
	scaled := value * factor
	floor := math.Floor(scaled)
	var rounded float64
	if math.Abs(scaled-floor-0.5) < 1e-9 {
		if int64(floor)%2 == 0 {
			rounded = floor
		} else {
			rounded = floor + 1
		}
	} else {
		// Math.round(x) has floor(x + 0.5) semantics, not Go's away-from-zero
		// rounding for negative ties.
		rounded = math.Floor(scaled + 0.5)
	}
	return rounded / factor
}

func roundJS(value float64) float64 { return math.Floor(value + 0.5) }

// LogRatio is the canonical 0..1 logarithmic normalizer used by the public
// score. It is exported for collector/contract tests, not as an alternate
// scoring rule.
func LogRatio(value, fullAt float64) float64 {
	if value <= 0 {
		return 0
	}
	return min(math.Log10(value+1)/math.Log10(fullAt+1), 1)
}

func starEngagementMultiplier(ratio *float64) float64 {
	if ratio == nil || *ratio >= 0.04 {
		return 1
	}
	if *ratio >= 0.02 {
		return 0.85
	}
	if *ratio >= 0.01 {
		return 0.7
	}
	return 0.5
}

func clampScore(value float64) float64 { return roundToEven(max(0, min(value, 100)), 2) }

// SpamBotScore is stored internally with a completed score. It is deliberately
// separate from the public red-flag penalty and follows src/lib/score.ts.
func SpamBotScore(m RawMetrics) float64 {
	score := 0.0
	if m.PRFloodSuspect {
		severity := max(0, min(1, ((m.TopRepoPRShare-0.5)/0.5)*0.5+((m.TemplatedPRRatio-0.5)/0.5)*0.5))
		score += 3 + 4*severity
	}
	if m.RecentMergedPRSample >= 8 && m.ExternalTrivialPRCount/m.RecentMergedPRSample > 0.3 {
		score += min(4, ((m.ExternalTrivialPRCount/m.RecentMergedPRSample-0.3)/0.6)*4)
	}
	rejected := m.ClosedUnmergedPRCount
	if m.MaintainerClosedUnmergedPRCount != nil {
		rejected = *m.MaintainerClosedUnmergedPRCount
	} else if m.SelfClosedExternalPRCount != nil || m.SelfClosedOwnRepoPRCount != nil {
		rejected = 0
	}
	decided := m.MergedPRCount + rejected
	if decided >= 10 && m.PRRejectionRate > 0.5 {
		score += min(2, ((m.PRRejectionRate-0.5)/0.5)*2)
	}
	if m.Following > 1000 && m.Followers < m.Following*0.3 {
		score += 2
	}
	if m.AccountAgeYears < 1 && m.PublicRepos > 30 {
		score += 1.5
	}
	fetched := max(m.FetchedRepoCount, 1)
	if m.ForkRepoCount/fetched > 0.7 && m.NonemptyOriginalRepoCount <= 2 {
		score += 1.5
	}
	if (m.Bio == nil || *m.Bio == "") && m.Followers < 3 && m.TotalStars == 0 && m.MergedPRCount < 2 {
		score++
	}
	return roundJS(max(0, min(score, 10))*10) / 10
}

func docLikePRRatio(m RawMetrics, sample float64) float64 {
	if m.RecentExternalDocLikePRRatio != nil {
		return *m.RecentExternalDocLikePRRatio
	}
	if m.RecentDocLikePRRatio != nil {
		return *m.RecentDocLikePRRatio
	}
	if sample > 0 && m.RecentExternalDocLikePRCount != nil {
		return *m.RecentExternalDocLikePRCount / sample
	}
	if sample > 0 && m.RecentDocLikePRCount != nil {
		return *m.RecentDocLikePRCount / sample
	}
	return 0
}

func docLikeSample(m RawMetrics) float64 {
	if m.RecentExternalPRSample != nil {
		return *m.RecentExternalPRSample
	}
	return m.RecentMergedPRSample
}

func docLikePRVolumeDiscount(m RawMetrics, prVolume float64) float64 {
	return prVolume * externalPRShare(m) * (1 - presentationDiscount(m)) * .8
}
func contributionQualityCap(m RawMetrics) (float64, bool) { return 0, false }

func impactPrestigeSignal(m RawMetrics) float64 {
	return max(0, min(valueOr(m.ImpactPrestigeScore, LogRatio(m.MaxImpactRepoStars, 100000)), 1))
}

func highImpactCorePRBonus(m RawMetrics) float64 {
	core := valueOrZero(m.CoreImpactPRCount)
	starSignal := impactPrestigeSignal(m)
	if core < 2 || starSignal < 0.5 {
		return 0
	}
	return min(2, starSignal*0.8+min(core/5, 1)*1.2)
}

const (
	ownPRVolumeFullAt   = 200.0
	ownPRCommunityBonus = 6.0
)

// ownPRCommunityCredit is the v13 extra 6·A·logRatio(own, 200). Snapshots
// without ExternalMergedPRCount keep the v10 single-pool score.
func ownPRCommunityCredit(m RawMetrics) float64 {
	if m.ExternalMergedPRCount == nil {
		return 0
	}
	community := max(0, min(valueOrZero(m.OwnPRCommunity), 1))
	if community == 0 {
		return 0
	}
	external := max(0, min(*m.ExternalMergedPRCount, m.MergedPRCount))
	own := max(0, m.MergedPRCount-external)
	return LogRatio(own, ownPRVolumeFullAt) * ownPRCommunityBonus * community
}

// softMin is the log-sum-exp soft minimum. It approaches the smaller input
// without the hard cut v18 applied to contribution quality.
func softMin(values []float64, k float64) float64 {
	finite := make([]float64, 0, len(values))
	for _, value := range values {
		if !math.IsInf(value, 0) && !math.IsNaN(value) {
			finite = append(finite, value)
		}
	}
	if len(finite) == 0 {
		return math.Inf(1)
	}
	peak := -k * finite[0]
	for _, value := range finite[1:] {
		peak = max(peak, -k*value)
	}
	sum := 0.0
	for _, value := range finite {
		sum += math.Exp(-k*value - peak)
	}
	return -(peak + math.Log(sum)) / k
}

func contributionEvidenceBounds(m RawMetrics) []float64 {
	smooth := func(value float64) float64 { x := max(0, min(1, value)); return x * x * (3 - 2*x) }
	volume := smooth((m.MergedPRCount - 40) / 80)
	prestige := impactPrestigeSignal(m)
	strongPrestige := smooth((prestige - .65) / .15)
	coreProtection := smooth((valueOrZero(m.CoreImpactPRCount) - 40) / 60)
	prestigeCap := 20 + 3*smooth((prestige-.3)/.5) + 4*strongPrestige + 2.5*coreProtection*(1-strongPrestige)
	// Stars on own projects do not establish outside adoption. Missing external
	// counts are unknown, so recognition stays out of the ceiling.
	bounds := []float64{27, 27 - (27-prestigeCap)*volume}
	if m.ExternalMergedPRCount != nil {
		external := max(0, min(*m.ExternalMergedPRCount, m.MergedPRCount))
		own := max(0, m.MergedPRCount-external)
		community := max(0, min(valueOrZero(m.OwnPRCommunity), 1))
		// Keep the 80-landing scale synchronized with TypeScript and Python.
		bounds = append(bounds, 20+7*(1-math.Exp(-(external+own*community)/80)))
	}
	if cap, applies := contributionQualityCap(m); applies {
		bounds = append(bounds, cap)
	}
	return bounds
}

func contributionEvidenceCeiling(m RawMetrics) float64 {
	return softMin(contributionEvidenceBounds(m), 6)
}

func lowPrestigeBulkContributionCap(m RawMetrics) (float64, bool) {
	cap := 27.0
	for _, bound := range contributionEvidenceBounds(m) {
		cap = min(cap, bound)
	}
	return cap, true
}

func saturateToward(raw, ceiling float64) float64 {
	if raw <= 0 {
		return 0
	}
	if math.IsInf(ceiling, 1) {
		return raw
	}
	if ceiling <= 0 {
		return 0
	}
	return softMin([]float64{raw, ceiling}, 3)
}

func clampUnit(value float64) float64 { return max(0, min(1, value)) }

func impactSubstance(m RawMetrics) float64 {
	trivialCount := max(0, m.ExternalTrivialPRCount)
	sample := max(0, m.RecentMergedPRSample)
	trivialKnown := sample > 0 || trivialCount > 0
	trivialShare := 0.0
	if trivialKnown {
		trivialShare = trivialCount / max(sample, max(trivialCount, 1))
	}
	core := max(0, valueOrZero(m.CoreImpactPRCount))
	docLike := max(0, valueOrZero(m.DocLikeImpactPRCount))
	classKnown := core+docLike > 0
	classQuality := 1.0
	if classKnown {
		classQuality = 0.45 + 0.55*core/(core+docLike)
	}
	presentationKnown := m.PresentationChurnShare != nil
	presentation := 0.0
	if presentationKnown {
		presentation = clampUnit(*m.PresentationChurnShare)
	}
	if !trivialKnown && !classKnown && !presentationKnown {
		return 1
	}
	work := max(m.ImpactPRCount, max(sample, max(trivialCount, max(core+docLike, 1))))
	trivialCoverage := 0.0
	if trivialKnown {
		trivialCoverage = min(1, max(sample, trivialCount)/work)
	}
	classCoverage := 0.0
	if classKnown {
		classCoverage = min(1, (core+docLike)/work)
	}
	presentationCoverage := 0.0
	if presentationKnown {
		covered := sample
		if m.PresentationPRSample != nil {
			covered = *m.PresentationPRSample
		}
		presentationCoverage = min(1, max(covered, 0)/work)
	}
	quality := (1 - trivialCoverage*0.55*trivialShare) * (1 - classCoverage*(1-classQuality)) * (1 - presentationCoverage*0.5*presentation)
	return max(0.18, min(1, 0.22+0.78*quality))
}

func repoConcentration(repos []ImpactRepo) float64 {
	if len(repos) == 0 {
		return 0
	}
	total := 0.0
	for _, repo := range repos {
		total += max(0, repo.PRs)
	}
	hhi := 0.0
	if total > 0 {
		for _, repo := range repos {
			share := max(0, repo.PRs) / total
			hhi += share * share
		}
	} else {
		share := 1 / float64(len(repos))
		hhi = share * float64(len(repos))
	}
	if len(repos) <= 1 {
		return 1
	}
	equal := 1 / float64(len(repos))
	return clampUnit((hhi - equal) / (1 - equal))
}

func dominantRepoWork(m RawMetrics) float64 {
	if len(m.ImpactRepos) > 0 {
		maxWork := 0.0
		for _, repo := range m.ImpactRepos {
			work := max(0, repo.PRs) + max(0, repo.Commits)/4
			if work > maxWork {
				maxWork = work
			}
		}
		return maxWork
	}
	return max(0, m.ImpactPRCount) + max(0, valueOrZero(m.ImpactCommitCount))/4
}

func impactBreadth(m RawMetrics) float64 {
	known := false
	concentration := 0.0
	if len(m.ImpactRepos) > 0 {
		known = true
		concentration = repoConcentration(m.ImpactRepos)
	} else if valueOrZero(m.ImpactRepoCount) > 0 {
		known = true
		if *m.ImpactRepoCount <= 1 {
			concentration = 1
		}
	}
	if !known {
		return 1
	}
	// Sustained dominant-repo work softens concentration; drive-bys stay near the floor.
	work := dominantRepoWork(m)
	maintainerRelief := 1 - math.Exp(-work/60)
	effectiveConcentration := concentration * (1 - 0.4*maintainerRelief)
	spread := math.Pow(1-effectiveConcentration, 1.15)
	return 0.62 + 0.38*spread
}

func impactTouch(m RawMetrics) float64 {
	// A present commit count, even zero, means the collector measured work.
	// Older snapshots omit it; do not treat that omission as zero PRs.
	if m.ImpactCommitCount == nil && m.ImpactPRCount == 0 && len(m.ImpactRepos) == 0 && valueOrZero(m.ImpactRepoCount) == 0 {
		return 1
	}
	prs := max(0, m.ImpactPRCount)
	commits := max(0, valueOrZero(m.ImpactCommitCount))
	landed := 1 - math.Exp(-(prs+commits/4)/18)
	core := max(0, valueOrZero(m.CoreImpactPRCount))
	docLike := max(0, valueOrZero(m.DocLikeImpactPRCount))
	if core+docLike <= 0 {
		return landed
	}
	coverage := min(1, (core+docLike)/max(prs, max(core+docLike, 1)))
	coreMix := 0.35 + 0.65*core/(core+docLike)
	return landed * (1 - coverage*(1-coreMix))
}

func hasSocialOnlyDormantSignal(m RawMetrics) bool {
	return m.Followers >= 500 && m.LastYearContributions == 0 && m.MergedPRCount == 0 &&
		m.ImpactPRCount == 0 && m.MaxImpactRepoStars == 0 && m.TotalStars <= 300 &&
		valueOrZero(m.BestOriginalRepoQualityScore) < 0.85
}

func tierFor(final float64) (string, string) {
	switch {
	case final >= 90:
		return "夯", "封神 · 殿堂级标杆"
	case final >= 80:
		return "顶级", "顶级开发者 · 一线水准"
	case final >= 70:
		return "人上人", "优质贡献者 · 值得信任"
	case final >= 40:
		return "NPC", "普通账号 · 特征平庸存疑"
	default:
		return "拉完了", "低价值 · 疑似刷量/AI 机器人"
	}
}

// Score is a direct Go port of src/lib/score.ts. The API contract and scoring
// rules stay unchanged while the collector and persistence move out of Next.
func contentSkillDiscount(m RawMetrics) float64 {
	share := max(0, min(1, valueOrZero(m.ContentSkillStarShare)))
	confidence := max(0, min(1, valueOrZero(m.ContentSkillConfidence)))
	external := max(0, valueOrZero(m.ExternalMergedPRCount))
	engineering := max(max(0, valueOrZero(m.CoreImpactPRCount))*externalPRShare(m), external*(1-max(0, min(1, valueOrZero(m.PresentationChurnShare))))/20)
	starMass := max(0, m.TotalStars) / (max(0, m.TotalStars) + 5000)
	return 1 - 0.9*share*share*(3-2*share)*confidence*starMass/(1+engineering)
}

func originalProjectQuality(m RawMetrics) float64 {
	if m.NonemptyOriginalRepoCount == 0 {
		return 0
	} else {
		starQuality := 1.0
		if m.TotalStars > 0 {
			starQuality = max(0, min(valueOr(m.TopStarredOriginalRepoQualityScore, 1), 1))
		}
		starPoints := (LogRatio(valueOr(m.WeightedTotalStars, m.TotalStars), 5000)*7 + LogRatio(valueOr(m.WeightedMaxStars, m.MaxStars), 2000)*5) * starQuality * starEngagementMultiplier(m.TopRepoEngagementRatio) * contentSkillDiscount(m)
		projectSubstance := max(0, min(valueOr(m.BestOriginalRepoQualityScore, 0), 1)) * 6
		return roundToEven(starPoints+projectSubstance, 1)
	}

}

func Score(m RawMetrics) Scoring {
	sub := SubScores{}
	agePoints := min(m.AccountAgeYears/6, 1) * 7
	spanPoints := 3.0
	if m.ContributionYearsActive == 0 {
		spanPoints = 0
	} else if m.ContributionYearsActive == 1 {
		spanPoints = 1
	} else if m.ContributionYearsActive == 2 {
		spanPoints = 2
	}
	sub.AccountMaturity = roundToEven(agePoints+spanPoints, 1)

	sub.OriginalProjectQuality = max(originalProjectQuality(m), max(0, min(18, valueOrZero(m.PersonalOriginalProjectQualityScore))))

	prVolumeRaw := LogRatio(m.MergedPRCount, 200) * 16
	prVolume := max(0, prVolumeRaw-docLikePRVolumeDiscount(m, prVolumeRaw))
	hasClosedPRBreakdown := m.MaintainerClosedUnmergedPRCount != nil || m.SelfClosedExternalPRCount != nil || m.SelfClosedOwnRepoPRCount != nil
	acceptanceTotal := max(m.MergedPRCount, m.TotalPRCount)
	if hasClosedPRBreakdown {
		acceptanceTotal = max(m.MergedPRCount, m.MergedPRCount+valueOrZero(m.MaintainerClosedUnmergedPRCount))
	}
	acceptance := 0.0
	if acceptanceTotal >= 3 {
		acceptance = m.MergedPRCount / acceptanceTotal * 6
	} else {
		acceptance = m.MergedPRCount * 1.2
	}
	acceptance = min(acceptance, 6)
	contributionRaw := prVolume + ownPRCommunityCredit(m) + acceptance - docLikePRVolumeDiscount(m, acceptance) + LogRatio(m.IssuesCreated, 100)*5 + highImpactCorePRBonus(m)*(1-(1-presentationDiscount(m))*.8)
	sub.ContributionQuality = roundToEven(saturateToward(max(0, contributionRaw), contributionEvidenceCeiling(m)), 1)

	substance := impactSubstance(m)
	breadth := impactBreadth(m)
	prestige := 9 * impactPrestigeSignal(m) * substance * impactTouch(m) * (0.72 + 0.28*breadth)
	depth := 11 * (1 - math.Exp(-max(0, m.ImpactDepthRaw)/4)) * substance * breadth
	ecosystemRaw := (prestige + depth) * ecosystemPresentationDiscount(m) * (1 - (1-contentSkillDiscount(m))*(1-externalPRShare(m)))
	sub.EcosystemImpact = roundToEven(ecosystemRaw, 1)

	followerPoints := LogRatio(m.Followers, 2000) * 5
	ratioPoints := 0.0
	if m.Following > 2000 && m.Followers < m.Following*0.3 {
		ratioPoints = 0
	} else if m.Following == 0 {
		if m.Followers > 0 {
			ratioPoints = 3
		}
	} else {
		ratio := m.Followers / m.Following
		switch {
		case ratio >= 2:
			ratioPoints = 3
		case ratio >= 1:
			ratioPoints = 2
		case ratio >= 0.5:
			ratioPoints = 1.5
		default:
			ratioPoints = 1
		}
	}
	communityRaw := followerPoints + ratioPoints
	if hasSocialOnlyDormantSignal(m) {
		communityRaw = min(communityRaw, 2.5)
	}
	sub.CommunityInfluence = roundToEven(communityRaw, 1)

	contributionPoints := LogRatio(m.LastYearContributions, 2000) * 8
	recencyPoints := 0.0
	if m.DaysSinceLastActivity != nil {
		switch {
		case *m.DaysSinceLastActivity <= 90:
			recencyPoints = 4.5
		case *m.DaysSinceLastActivity <= 365:
			recencyPoints = 2
		}
	}
	sub.ActivityAuthenticity = roundToEven(contributionPoints+recencyPoints+min(m.ActivityTypeCount, 4)*1.125, 1)

	base := roundToEven(sub.AccountMaturity+sub.OriginalProjectQuality+sub.ContributionQuality+sub.EcosystemImpact+sub.CommunityInfluence+sub.ActivityAuthenticity, 1)
	riskAssessment, riskNotes, redFlags, totalPenalty := AssessRisk(m)
	final := clampScore(roundToEven(base-totalPenalty, 2))
	tier, tierLabel := tierFor(final)
	return Scoring{SubScores: sub, BaseScore: base, RedFlags: redFlags, RiskAssessment: riskAssessment, RiskNotes: riskNotes, TotalPenalty: totalPenalty, FinalScore: final, Tier: tier, TierLabel: tierLabel}
}

func formatNumber(value float64) string {
	if value == math.Trunc(value) {
		return fmt.Sprintf("%.0f", value)
	}
	return fmt.Sprintf("%v", value)
}
