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
	Username                                  string   `json:"username"`
	ProfileURL                                *string  `json:"profile_url"`
	AvatarURL                                 *string  `json:"avatar_url"`
	Name                                      *string  `json:"name"`
	Bio                                       *string  `json:"bio"`
	Company                                   *string  `json:"company"`
	AccountAgeYears                           float64  `json:"account_age_years"`
	CreatedAt                                 *string  `json:"created_at"`
	Followers                                 float64  `json:"followers"`
	Following                                 float64  `json:"following"`
	PublicRepos                               float64  `json:"public_repos"`
	FetchedRepoCount                          float64  `json:"fetched_repo_count"`
	OriginalRepoCount                         float64  `json:"original_repo_count"`
	NonemptyOriginalRepoCount                 float64  `json:"nonempty_original_repo_count"`
	ForkRepoCount                             float64  `json:"fork_repo_count"`
	EmptyOriginalRepoCount                    float64  `json:"empty_original_repo_count"`
	TotalStars                                float64  `json:"total_stars"`
	MaxStars                                  float64  `json:"max_stars"`
	TopRepoEngagementRatio                    *float64 `json:"top_repo_engagement_ratio,omitempty"`
	AttributedOriginalRepoCount               *float64 `json:"attributed_original_repo_count,omitempty"`
	AttributedOriginalRepoStars               *float64 `json:"attributed_original_repo_stars,omitempty"`
	AttributedOriginalRepos                   []string `json:"attributed_original_repos,omitempty"`
	BestOriginalRepoQualityScore              *float64 `json:"best_original_repo_quality_score,omitempty"`
	BestOriginalRepoQualityRepo               *string  `json:"best_original_repo_quality_repo,omitempty"`
	TopStarredOriginalRepoQualityScore        *float64 `json:"top_starred_original_repo_quality_score,omitempty"`
	TopStarredOriginalRepoQualityRepo         *string  `json:"top_starred_original_repo_quality_repo,omitempty"`
	MergedPRCount                             float64  `json:"merged_pr_count"`
	WorkflowLandedPRCount                     *float64 `json:"workflow_landed_pr_count,omitempty"`
	TotalPRCount                              float64  `json:"total_pr_count"`
	IssuesCreated                             float64  `json:"issues_created"`
	LastYearContributions                     float64  `json:"last_year_contributions"`
	ActivityTypeCount                         float64  `json:"activity_type_count"`
	ContributionYearsActive                   float64  `json:"contribution_years_active"`
	DaysSinceLastActivity                     *float64 `json:"days_since_last_activity"`
	RecentMergedPRSample                      float64  `json:"recent_merged_pr_sample"`
	RecentTrivialPRCount                      float64  `json:"recent_trivial_pr_count"`
	RecentDocLikePRCount                      *float64 `json:"recent_doc_like_pr_count,omitempty"`
	RecentDocLikePRRatio                      *float64 `json:"recent_doc_like_pr_ratio,omitempty"`
	RecentExternalPRSample                    *float64 `json:"recent_external_pr_sample,omitempty"`
	RecentExternalDocLikePRCount              *float64 `json:"recent_external_doc_like_pr_count,omitempty"`
	RecentExternalDocLikePRRatio              *float64 `json:"recent_external_doc_like_pr_ratio,omitempty"`
	ExternalTrivialPRCount                    float64  `json:"external_trivial_pr_count"`
	MaxImpactRepoStars                        float64  `json:"max_impact_repo_stars"`
	ImpactPrestigeScore                       *float64 `json:"impact_prestige_score,omitempty"`
	ImpactPRCount                             float64  `json:"impact_pr_count"`
	WorkflowLandedImpactPRCount               *float64 `json:"workflow_landed_impact_pr_count,omitempty"`
	ImpactDepthRaw                            float64  `json:"impact_depth_raw"`
	ImpactQualityCap                          *float64 `json:"impact_quality_cap,omitempty"`
	VerifiedImpactPRCount                     *float64 `json:"verified_impact_pr_count,omitempty"`
	CoreImpactPRCount                         *float64 `json:"core_impact_pr_count,omitempty"`
	DocLikeImpactPRCount                      *float64 `json:"doc_like_impact_pr_count,omitempty"`
	UnverifiedImpactPRCount                   *float64 `json:"unverified_impact_pr_count,omitempty"`
	ImpactRepoCount                           *float64 `json:"impact_repo_count,omitempty"`
	ImpactCommitCount                         *float64 `json:"impact_commit_count,omitempty"`
	CommitContributionAggregationUnavailable  bool     `json:"commit_contribution_aggregation_unavailable"`
	MergedPRContributionAggregationIncomplete bool     `json:"merged_pr_contribution_aggregation_incomplete"`
	StarInflationSuspect                      bool     `json:"star_inflation_suspect"`
	ClosedUnmergedPRCount                     float64  `json:"closed_unmerged_pr_count"`
	MaintainerClosedUnmergedPRCount           *float64 `json:"maintainer_closed_unmerged_pr_count,omitempty"`
	SelfClosedExternalPRCount                 *float64 `json:"self_closed_external_pr_count,omitempty"`
	SelfClosedOwnRepoPRCount                  *float64 `json:"self_closed_own_repo_pr_count,omitempty"`
	UnknownClosedUnmergedPRCount              *float64 `json:"unknown_closed_unmerged_pr_count,omitempty"`
	PRRejectionRate                           float64  `json:"pr_rejection_rate"`
	RecentPRSample                            float64  `json:"recent_pr_sample"`
	TopRepoPRTarget                           *string  `json:"top_repo_pr_target"`
	TopRepoPRShare                            float64  `json:"top_repo_pr_share"`
	TemplatedPRRatio                          float64  `json:"templated_pr_ratio"`
	PRFloodSuspect                            bool     `json:"pr_flood_suspect"`
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

type Scoring struct {
	SubScores    SubScores `json:"sub_scores"`
	BaseScore    float64   `json:"base_score"`
	RedFlags     []RedFlag `json:"red_flags"`
	TotalPenalty float64   `json:"total_penalty"`
	FinalScore   float64   `json:"final_score"`
	Tier         string    `json:"tier"`
	TierLabel    string    `json:"tier_label"`
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
	sample := docLikeSample(m)
	ratio := docLikePRRatio(m, sample)
	if sample < 20 || ratio < 0.55 {
		return 0
	}
	severity := max(0, min(1, (ratio-0.55)/0.075))
	return min(prVolume*0.55, 2.5+severity*3)
}

func contributionQualityCap(m RawMetrics) (float64, bool) {
	sample := docLikeSample(m)
	ratio := docLikePRRatio(m, sample)
	if sample < 20 || ratio < 0.55 {
		return 0, false
	}
	lowTrustImpact := m.ImpactQualityCap != nil && *m.ImpactQualityCap <= 4 && valueOrZero(m.CoreImpactPRCount) <= 2
	weakTopStarProject := valueOr(m.TopStarredOriginalRepoQualityScore, 1) < 0.3 && m.TotalStars > 0
	selfClosedExternal := valueOrZero(m.SelfClosedExternalPRCount)
	totalExternalish := m.MergedPRCount + valueOrZero(m.MaintainerClosedUnmergedPRCount) + selfClosedExternal
	heavySelfClosedExternal := totalExternalish >= 20 && selfClosedExternal/totalExternalish >= 0.25
	weakOwnProjectSignal := m.MaxStars < 100 && m.TotalStars < 300 && valueOr(m.TopStarredOriginalRepoQualityScore, 1) < 0.6
	if lowTrustImpact && (weakTopStarProject || weakOwnProjectSignal || heavySelfClosedExternal) {
		return 12, true
	}
	return 0, false
}

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

func lowPrestigeBulkContributionCap(m RawMetrics) (float64, bool) {
	if m.MergedPRCount < 80 || impactPrestigeSignal(m) >= LogRatio(10000, 100000) || m.MaxStars >= 1000 {
		return 0, false
	}
	return 22, true
}

func templatedPRFloodPenalty(m RawMetrics) (float64, bool) {
	if !m.PRFloodSuspect {
		return 0, false
	}
	concentrationSeverity := max(0, min(1, ((m.TopRepoPRShare-0.5)/0.5)*0.5+((m.TemplatedPRRatio-0.5)/0.5)*0.5))
	sample := m.RecentMergedPRSample
	if sample == 0 {
		sample = m.RecentPRSample
	}
	docLikeRatio := docLikePRRatio(m, sample)
	hasPopularImpactSignal := m.ImpactPRCount > 0 || m.MaxImpactRepoStars >= 10000
	lowCoreImpact := hasPopularImpactSignal && valueOrZero(m.CoreImpactPRCount) <= 2 && (m.ImpactQualityCap != nil || m.MaxImpactRepoStars >= 10000)
	weakOwnProject := m.TotalStars < 300 && valueOr(m.TopStarredOriginalRepoQualityScore, 1) < 0.5
	lowQualityEvidence := 0
	if sample >= 20 && docLikeRatio >= 0.55 {
		lowQualityEvidence++
	}
	if m.PRRejectionRate >= 0.35 {
		lowQualityEvidence++
	}
	if lowCoreImpact {
		lowQualityEvidence++
	}
	if weakOwnProject {
		lowQualityEvidence++
	}
	extremeFlood := m.TopRepoPRShare >= 0.85 && m.TemplatedPRRatio >= 0.75
	if lowQualityEvidence >= 2 || (extremeFlood && lowQualityEvidence >= 1) {
		return 10 + roundJS(10*concentrationSeverity), true
	}
	if lowQualityEvidence == 1 || extremeFlood {
		return 6 + roundJS(4*concentrationSeverity), true
	}
	return 4 + roundJS(4*concentrationSeverity), true
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

	if m.NonemptyOriginalRepoCount == 0 {
		sub.OriginalProjectQuality = 0
	} else {
		starQuality := 1.0
		if m.TotalStars > 0 {
			starQuality = max(0, min(valueOr(m.TopStarredOriginalRepoQualityScore, 1), 1))
		}
		starPoints := (LogRatio(m.TotalStars, 5000)*7 + LogRatio(m.MaxStars, 2000)*5) * starQuality * starEngagementMultiplier(m.TopRepoEngagementRatio)
		projectSubstance := max(0, min(valueOr(m.BestOriginalRepoQualityScore, 0), 1)) * 6
		sub.OriginalProjectQuality = roundToEven(starPoints+projectSubstance, 1)
	}

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
	contributionRaw := prVolume + acceptance + LogRatio(m.IssuesCreated, 100)*5 + highImpactCorePRBonus(m)
	contributionCap := 27.0
	if cap, applies := contributionQualityCap(m); applies {
		contributionCap = min(contributionCap, cap)
	}
	if cap, applies := lowPrestigeBulkContributionCap(m); applies {
		contributionCap = min(contributionCap, cap)
	}
	sub.ContributionQuality = roundToEven(min(contributionRaw, contributionCap), 1)

	ecosystemRaw := impactPrestigeSignal(m)*9 + min(m.ImpactDepthRaw/8, 1)*11
	if m.ImpactQualityCap != nil {
		ecosystemRaw = min(ecosystemRaw, *m.ImpactQualityCap)
	}
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
	flags := make([]RedFlag, 0)
	flag := func(name string, penalty float64, detail string) {
		flags = append(flags, RedFlag{Flag: name, Penalty: penalty, Detail: detail})
	}
	fetched := max(m.FetchedRepoCount, 1)
	if m.AccountAgeYears < 1 && m.PublicRepos > 30 {
		flag("new_account_mass_repos", 10, fmt.Sprintf("Account <1yr old with %s repos — possible mass creation.", formatNumber(m.PublicRepos)))
	}
	if m.ForkRepoCount/fetched > 0.7 && m.NonemptyOriginalRepoCount <= 2 {
		flag("mostly_forks", 10, fmt.Sprintf("%s/%s repos are forks with little original work.", formatNumber(m.ForkRepoCount), formatNumber(fetched)))
	}
	if m.NonemptyOriginalRepoCount == 0 {
		flag("no_original_work", 10, "No non-empty original repositories.")
	}
	if m.EmptyOriginalRepoCount >= 5 && m.EmptyOriginalRepoCount/fetched > 0.5 {
		flag("mostly_empty_repos", 5, fmt.Sprintf("%s empty original repos — likely placeholder/spam.", formatNumber(m.EmptyOriginalRepoCount)))
	}
	if m.Following > 1000 && m.Followers < m.Following*0.3 {
		flag("follow_farming", 10, fmt.Sprintf("following %s >> followers %s — follow-farming pattern.", formatNumber(m.Following), formatNumber(m.Followers)))
	}
	if (m.Bio == nil || *m.Bio == "") && m.Followers < 3 && m.TotalStars == 0 && m.MergedPRCount < 2 {
		flag("ghost_profile", 8, "Empty profile with negligible footprint.")
	}
	days := 999.0
	if m.DaysSinceLastActivity != nil {
		days = *m.DaysSinceLastActivity
	}
	if m.ContributionYearsActive <= 1 && m.AccountAgeYears > 2 && days > 365 {
		flag("burst_then_dormant", 5, "Active in only one year then dormant — burst pattern.")
	}
	if hasSocialOnlyDormantSignal(m) {
		flag("social_only_dormant_profile", 5, fmt.Sprintf("%s followers but 0 last-year contributions, 0 PRs, no external impact, and no strong original project signal — social/profile attention is disconnected from code work.", formatNumber(m.Followers)))
	}
	if m.StarInflationSuspect {
		flag("possible_star_inflation", 5, "Top repo has many stars but near-zero forks/issues — possible bought stars.")
	}
	if m.RecentMergedPRSample >= 10 && m.ExternalTrivialPRCount/m.RecentMergedPRSample > 0.5 {
		flag("trivial_pr_farming", 8, fmt.Sprintf("%s/%s recent merged PRs are ≤5-line changes into others' ≥200★ repos — garbage PR farming into popular community projects.", formatNumber(m.ExternalTrivialPRCount), formatNumber(m.RecentMergedPRSample)))
	}
	if penalty, applies := templatedPRFloodPenalty(m); applies {
		repo := "one repo"
		if m.TopRepoPRTarget != nil {
			repo = *m.TopRepoPRTarget
		}
		flag("templated_pr_flooding", penalty, fmt.Sprintf("近期 %s%% 的 PR 集中刷向 %s，%s%% 标题高度模板化（%s 个样本） — 模式化批量贡献风险，需结合 diff 质量人工复核。", formatNumber(roundJS(m.TopRepoPRShare*100)), repo, formatNumber(roundJS(m.TemplatedPRRatio*100)), formatNumber(m.RecentPRSample)))
	}
	rejected := valueOr(m.MaintainerClosedUnmergedPRCount, m.ClosedUnmergedPRCount)
	decided := m.MergedPRCount + rejected
	if decided >= 10 && m.PRRejectionRate > 0.5 {
		penalty := 8.0
		if m.PRRejectionRate > 0.7 {
			penalty = 10
		}
		flag("high_pr_rejection", penalty, fmt.Sprintf("%s/%s 个已决 PR 被维护者关闭未合并（被拒率 %s%%）— 低质 / 频繁被拒。", formatNumber(rejected), formatNumber(decided), formatNumber(roundJS(m.PRRejectionRate*100))))
	}

	totalPenalty := 0.0
	for _, flag := range flags {
		totalPenalty += flag.Penalty
	}
	totalPenalty = min(totalPenalty, 40)
	final := clampScore(roundToEven(base-totalPenalty, 2))
	tier, tierLabel := tierFor(final)
	return Scoring{SubScores: sub, BaseScore: base, RedFlags: flags, TotalPenalty: totalPenalty, FinalScore: final, Tier: tier, TierLabel: tierLabel}
}

func formatNumber(value float64) string {
	if value == math.Trunc(value) {
		return fmt.Sprintf("%.0f", value)
	}
	return fmt.Sprintf("%v", value)
}
