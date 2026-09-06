package backend

import "math"

const (
	riskVersion              = "v10"
	riskTotalCap             = 25.0
	riskContributionCap      = 16.0
	riskSocialCap            = 9.0
	riskFullSample           = 40.0
	riskMinimumContribution  = 20.0
	riskMinimumRejection     = 20.0
	riskMinimumFloodSample   = 20.0
	riskTrivialRate          = 0.5
	riskTrivialTransition    = 0.4
	riskTemplateShare        = 0.6
	riskTemplateTitleRatio   = 0.6
	riskFollowMinimum        = 1500.0
	riskFollowRatio          = 0.2
	riskStarMinimum          = 500.0
	riskStarEngagementRatio  = 0.02
	riskRejectionWilsonLower = 0.4
	riskWilsonZ              = 1.96
	riskReviewMinimum        = 20.0
	riskHighMinimum          = 60.0
	riskRepositoryLimit      = 200.0
	riskMergedPRLimit        = 50.0
	riskAllPRLimit           = 30.0
)

type riskCandidate struct {
	signal RiskSignal
	raw    float64
}

const riskWindow = "bounded public snapshot: up to 200 repositories, up to 50 merged PRs, up to 30 all-state PRs"

func riskClamp01(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return max(0, min(value, 1))
}

func riskRound(value float64, digits int) float64 {
	return roundToEven(value, digits)
}

func riskSampleFactor(sample float64) float64 {
	return min(1, max(0, sample)/riskFullSample)
}

func SmoothedRate(events, sample float64) float64 {
	n := max(0, sample)
	x := max(0, min(n, events))
	return (x + 1) / (n + 2)
}

// WilsonLower returns the 95% Wilson lower confidence bound for a proportion.
func WilsonLower(rejected, decided, z float64) float64 {
	n := max(0, decided)
	if n <= 0 {
		return 0
	}
	x := max(0, min(n, rejected))
	p := x / n
	z2 := z * z
	denominator := 1 + z2/n
	numerator := p + z2/(2*n) - z*math.Sqrt((p*(1-p))/n+z2/(4*n*n))
	return riskClamp01(numerator / denominator)
}

func riskCoverage(m RawMetrics) RiskCoverage {
	fetched := max(0, m.FetchedRepoCount)
	publicRepos := max(1, m.PublicRepos)
	mergedSample := max(0, m.RecentMergedPRSample)
	mergedTotal := max(1, min(m.MergedPRCount, riskMergedPRLimit))
	allSample := max(0, m.RecentPRSample)
	allTotal := max(1, min(m.TotalPRCount, riskAllPRLimit))
	return RiskCoverage{
		Repo:     riskRound(riskClamp01(fetched/publicRepos), 4),
		MergedPR: riskRound(riskClamp01(mergedSample/mergedTotal), 4),
		AllPR:    riskRound(riskClamp01(allSample/allTotal), 4),
	}
}

func riskConfidence(coverage RiskCoverage) float64 {
	return riskClamp01(0.4*coverage.Repo + 0.4*coverage.MergedPR + 0.2*coverage.AllPR)
}

func riskEvidence(m RawMetrics, observed map[string]any, sample *float64, threshold map[string]float64) RiskEvidence {
	coverage := riskCoverage(m)
	return RiskEvidence{
		Observed:   observed,
		SampleSize: sample,
		Threshold:  threshold,
		Coverage: map[string]float64{
			"repo":      coverage.Repo,
			"merged_pr": coverage.MergedPR,
			"all_pr":    coverage.AllPR,
		},
		Window: riskWindow,
	}
}

func newRiskCandidate(m RawMetrics, flag, family string, raw, severity, confidence float64, detail string, observed map[string]any, sample *float64, threshold map[string]float64) *riskCandidate {
	return &riskCandidate{
		raw: max(0, raw),
		signal: RiskSignal{
			Flag:        flag,
			Family:      family,
			Disposition: "note",
			Severity:    riskRound(riskClamp01(severity), 4),
			Confidence:  riskRound(riskClamp01(confidence), 4),
			Penalty:     0,
			Detail:      detail,
			Evidence:    riskEvidence(m, observed, sample, threshold),
		},
	}
}

func addFootprintRiskNote(m RawMetrics, result *[]*riskCandidate, flag, detail string, observed map[string]any, severity float64) {
	coverage := riskCoverage(m)
	confidence := riskConfidence(coverage)
	sample := m.FetchedRepoCount
	*result = append(*result, newRiskCandidate(m, flag, "footprint", 0, severity, confidence, detail, observed, &sample, nil))
}

func addContributionRisk(m RawMetrics, result *[]*riskCandidate, flag string, raw, severity float64, detail string, observed map[string]any, sample float64, threshold map[string]float64, confidence float64) {
	*result = append(*result, newRiskCandidate(m, flag, "contribution", raw, severity, confidence*max(riskSampleFactor(sample), 0.25), detail, observed, &sample, threshold))
}

func applyRiskFamilyCap(candidates []*riskCandidate, family string, cap float64) float64 {
	active := make([]*riskCandidate, 0)
	rawTotal := 0.0
	for _, candidate := range candidates {
		if candidate.signal.Family == family && candidate.raw > 0 {
			active = append(active, candidate)
			rawTotal += candidate.raw
		}
	}
	if rawTotal <= 0 {
		return 0
	}
	target := riskRound(min(cap, rawTotal), 2)
	factor := target / rawTotal
	assigned := 0.0
	for index, candidate := range active {
		penalty := 0.0
		if index == len(active)-1 {
			penalty = riskRound(max(0, target-assigned), 2)
		} else {
			penalty = riskRound(candidate.raw*factor, 2)
		}
		candidate.signal.Penalty = penalty
		if penalty > 0 {
			candidate.signal.Disposition = "penalty"
		}
		assigned = riskRound(assigned+penalty, 2)
	}
	return assigned
}

func assessSocialPair(followRaw, starRaw float64, follow, star *riskCandidate) {
	if followRaw <= 0 || starRaw <= 0 {
		return
	}
	// The one-point synergy term is split between the two legacy flag names.
	follow.raw = followRaw + 0.5
	star.raw = starRaw + 0.5
}

// AssessRisk implements the public v10 risk layer. It intentionally has no
// access to sub-scores; base score calculation remains the six-dimension kernel.
func AssessRisk(m RawMetrics) (RiskAssessment, []RiskSignal, []RedFlag, float64) {
	candidates := make([]*riskCandidate, 0)
	coverage := riskCoverage(m)
	coverageConfidence := riskConfidence(coverage)
	fetched := max(1, m.FetchedRepoCount)

	if m.AccountAgeYears < 1 && m.PublicRepos > 30 {
		addFootprintRiskNote(m, &candidates, "new_account_mass_repos", "新账号公开仓库较多，说明采集到的足迹可能来自批量建仓；这本身不等于作弊。", map[string]any{"account_age_years": m.AccountAgeYears, "public_repos": m.PublicRepos}, 0.5)
	}
	if m.ForkRepoCount/fetched > 0.7 && m.NonemptyOriginalRepoCount <= 2 {
		addFootprintRiskNote(m, &candidates, "mostly_forks", "公开仓库以 Fork 为主，原创足迹有限；这本身不等于作弊。", map[string]any{"fork_repo_count": m.ForkRepoCount, "fetched_repo_count": fetched, "nonempty_original_repo_count": m.NonemptyOriginalRepoCount}, 0.5)
	}
	if m.NonemptyOriginalRepoCount == 0 {
		addFootprintRiskNote(m, &candidates, "no_original_work", "当前公开采集范围内没有非空原创仓库；这只代表足迹有限，不代表作弊。", map[string]any{"nonempty_original_repo_count": m.NonemptyOriginalRepoCount}, 0.7)
	}
	if m.EmptyOriginalRepoCount >= 5 && m.EmptyOriginalRepoCount/fetched > 0.5 {
		addFootprintRiskNote(m, &candidates, "mostly_empty_repos", "公开原创仓库中空仓库占比较高；这只作为足迹提示，不扣分。", map[string]any{"empty_original_repo_count": m.EmptyOriginalRepoCount, "fetched_repo_count": fetched}, 0.5)
	}
	if m.Bio == nil && m.Followers < 3 && m.TotalStars == 0 && m.MergedPRCount < 2 {
		addFootprintRiskNote(m, &candidates, "ghost_profile", "个人资料和公开项目足迹都很少，当前数据不足以判断行为真实性。", map[string]any{"has_bio": false, "followers": m.Followers, "total_stars": m.TotalStars, "merged_pr_count": m.MergedPRCount}, 0.6)
	} else if m.Bio != nil && *m.Bio == "" && m.Followers < 3 && m.TotalStars == 0 && m.MergedPRCount < 2 {
		addFootprintRiskNote(m, &candidates, "ghost_profile", "个人资料和公开项目足迹都很少，当前数据不足以判断行为真实性。", map[string]any{"has_bio": false, "followers": m.Followers, "total_stars": m.TotalStars, "merged_pr_count": m.MergedPRCount}, 0.6)
	}
	days := 999.0
	if m.DaysSinceLastActivity != nil {
		days = *m.DaysSinceLastActivity
	}
	if m.ContributionYearsActive <= 1 && m.AccountAgeYears > 2 && days > 365 {
		addFootprintRiskNote(m, &candidates, "burst_then_dormant", "活动集中在较短时期且近期长期不活跃；这是时间覆盖提示，不扣分。", map[string]any{"contribution_years_active": m.ContributionYearsActive, "account_age_years": m.AccountAgeYears, "days_since_last_activity": days}, 0.5)
	}
	if hasSocialOnlyDormantSignal(m) {
		addFootprintRiskNote(m, &candidates, "social_only_dormant_profile", "社交关注度与当前公开代码足迹不匹配；这是待解释现象，不扣分。", map[string]any{"followers": m.Followers, "last_year_contributions": m.LastYearContributions, "merged_pr_count": m.MergedPRCount, "total_stars": m.TotalStars}, 0.5)
	}

	mergedSample := max(0, m.RecentMergedPRSample)
	externalTrivial := max(0, m.ExternalTrivialPRCount)
	trivialRate := SmoothedRate(externalTrivial, mergedSample)
	trivialSeverity := riskClamp01((trivialRate-riskTrivialRate)/riskTrivialTransition) * riskSampleFactor(mergedSample)
	trivialRaw := 0.0
	if mergedSample >= riskMinimumContribution && trivialRate > riskTrivialRate {
		trivialRaw = 8 * riskClamp01((trivialRate-riskTrivialRate)/riskTrivialTransition) * riskSampleFactor(mergedSample)
	}
	if mergedSample > 0 && externalTrivial > 0 && externalTrivial/mergedSample > 0.3 {
		detail := "外部热门仓库中的低实质 PR 比例偏高，但合并样本不足 20 个，仅作风险提示。"
		if mergedSample >= riskMinimumContribution {
			detail = "外部热门仓库中的低实质 PR 比例达到量化阈值；仅统计他人仓库，不惩罚正常自提 PR。"
		}
		sample := mergedSample
		addContributionRisk(m, &candidates, "trivial_pr_farming", trivialRaw, trivialSeverity, detail, map[string]any{"external_trivial_pr_count": externalTrivial, "merged_pr_sample": mergedSample, "smoothed_rate": riskRound(trivialRate, 4)}, sample, map[string]float64{"minimum_sample": riskMinimumContribution, "smoothed_rate": riskTrivialRate}, coverageConfidence)
	}

	rejected := 0.0
	rejectionMeasured := m.MaintainerClosedUnmergedPRCount != nil
	if rejectionMeasured {
		rejected = max(0, *m.MaintainerClosedUnmergedPRCount)
	}
	decided := max(0, m.MergedPRCount) + rejected
	rejectionLower := 0.0
	if rejectionMeasured {
		rejectionLower = WilsonLower(rejected, decided, riskWilsonZ)
	}
	rejectionSeverity := riskClamp01((rejectionLower-riskRejectionWilsonLower)/riskRejectionWilsonLower) * riskSampleFactor(decided)
	rejectionRaw := 0.0
	if rejectionMeasured && decided >= riskMinimumRejection && rejectionLower >= riskRejectionWilsonLower {
		rejectionRaw = 4 * riskClamp01((rejectionLower-riskRejectionWilsonLower)/riskRejectionWilsonLower)
	}
	if rejectionMeasured && decided > 0 && rejected > 0 {
		detail := "维护者关闭未合并的 PR 比例偏高，但样本量或 Wilson 95% 下界未达到扣分门槛，仅作风险提示。"
		if decided >= riskMinimumRejection && rejectionLower >= riskRejectionWilsonLower {
			detail = "维护者关闭未合并的 PR 的 Wilson 95% 下界达到量化阈值。"
		}
		sample := decided
		addContributionRisk(m, &candidates, "high_pr_rejection", rejectionRaw, rejectionSeverity, detail, map[string]any{"maintainer_closed_unmerged_pr_count": rejected, "merged_pr_count": m.MergedPRCount, "decided_pr_count": decided, "wilson_lower": riskRound(rejectionLower, 4)}, sample, map[string]float64{"minimum_decisions": riskMinimumRejection, "wilson_lower": riskRejectionWilsonLower}, coverageConfidence)
	}

	floodSample := max(0, m.RecentPRSample)
	share := riskClamp01(m.TopRepoPRShare)
	templatedRatio := riskClamp01(m.TemplatedPRRatio)
	// The collector sets this only after verifying that the dominant target is
	// external. A similar pattern in the user's own repository is normal work.
	floodObserved := m.PRFloodSuspect
	patternPass := floodSample >= riskMinimumFloodSample && share >= riskTemplateShare && templatedRatio >= riskTemplateTitleRatio
	patternSeverity := riskClamp01(((share-riskTemplateShare)/(1-riskTemplateShare) + (templatedRatio-riskTemplateTitleRatio)/(1-riskTemplateTitleRatio)) / 2)
	corroboratingSeverity := max(trivialSeverity, rejectionSeverity)
	templateRaw := 0.0
	if patternPass && corroboratingSeverity > 0 {
		templateRaw = 8 * patternSeverity * corroboratingSeverity
	}
	if floodObserved {
		corroborating := corroboratingSeverity > 0
		detail := "PR 目标集中或标题模板化，但缺少第二项独立质量证据；仅作风险提示，不单独扣分。"
		if patternPass && corroborating {
			detail = "PR 目标集中且标题模板化，并有外部低实质贡献或维护者拒绝率作为第二项证据；已按贡献风险族封顶。"
		}
		sample := floodSample
		addContributionRisk(m, &candidates, "templated_pr_flooding", templateRaw, patternSeverity, detail, map[string]any{"recent_pr_sample": floodSample, "top_repo_pr_share": share, "templated_pr_ratio": templatedRatio, "corroborating_evidence": corroborating}, sample, map[string]float64{"minimum_sample": riskMinimumFloodSample, "target_share": riskTemplateShare, "title_ratio": riskTemplateTitleRatio}, coverageConfidence)
	}

	following := max(0, m.Following)
	followers := max(0, m.Followers)
	followerRatio := followers / max(following, 1)
	followObserved := following > 0 && followerRatio < riskFollowRatio
	followRaw := 0.0
	if following >= riskFollowMinimum && followerRatio < riskFollowRatio {
		followRaw = 4 * riskClamp01((riskFollowRatio-followerRatio)/riskFollowRatio) * riskClamp01((following-riskFollowMinimum)/3000)
	}
	var follow *riskCandidate
	if followObserved {
		follow = newRiskCandidate(m, "follow_farming", "social", 0, riskClamp01((riskFollowRatio-followerRatio)/riskFollowRatio), coverageConfidence, "关注数量与粉丝数量明显失衡；当前只有单次快照，没有关注增长时间序列，不能单独判定刷粉。", map[string]any{"following": following, "followers": followers, "follower_ratio": riskRound(followerRatio, 4)}, nil, map[string]float64{"minimum_following": riskFollowMinimum, "follower_ratio": riskFollowRatio})
		candidates = append(candidates, follow)
	}

	engagement := m.TopRepoEngagementRatio
	starObserved := m.StarInflationSuspect
	starRaw := 0.0
	if starObserved && m.MaxStars >= riskStarMinimum && engagement != nil {
		starRaw = 4 * riskClamp01((riskStarEngagementRatio-*engagement)/riskStarEngagementRatio)
	}
	var star *riskCandidate
	if starObserved {
		severity := 0.5
		if starRaw > 0 {
			severity = riskClamp01(starRaw / 4)
		}
		observedEngagement := any(nil)
		if engagement != nil {
			observedEngagement = *engagement
		}
		detail := "存在星标/互动失衡迹象，但缺少足够星标或可公平测量的 engagement ratio，仅作风险提示。"
		if starRaw > 0 {
			detail = "高星标仓库的可测 engagement ratio 很低，且存在星标膨胀形态；只有与关注失衡同时出现才扣分。"
		}
		star = newRiskCandidate(m, "possible_star_inflation", "social", 0, severity, coverageConfidence, detail, map[string]any{"max_stars": m.MaxStars, "star_inflation_suspect": m.StarInflationSuspect, "engagement_ratio": observedEngagement}, nil, map[string]float64{"minimum_stars": riskStarMinimum, "engagement_ratio": riskStarEngagementRatio})
		candidates = append(candidates, star)
	}
	if follow != nil && star != nil {
		assessSocialPair(followRaw, starRaw, follow, star)
		if followRaw <= 0 || starRaw <= 0 {
			follow.raw, star.raw = 0, 0
			follow.signal.Detail = "关注失衡是单一社交异常；没有第二项独立星标证据，不扣分。"
			star.signal.Detail = "星标/互动异常是单一热度异常；没有第二项独立关注证据，不扣分。"
		}
	}

	contributionPenalty := applyRiskFamilyCap(candidates, "contribution", riskContributionCap)
	socialPenalty := applyRiskFamilyCap(candidates, "social", riskSocialCap)
	totalPenalty := riskRound(min(riskTotalCap, contributionPenalty+socialPenalty), 2)
	signals := make([]RiskSignal, 0, len(candidates))
	notes := make([]RiskSignal, 0)
	redFlags := make([]RedFlag, 0)
	for _, candidate := range candidates {
		signals = append(signals, candidate.signal)
		if candidate.signal.Penalty > 0 {
			redFlags = append(redFlags, RedFlag{Flag: candidate.signal.Flag, Penalty: candidate.signal.Penalty, Detail: candidate.signal.Detail})
		} else {
			note := candidate.signal
			note.Penalty = 0
			note.Disposition = "note"
			notes = append(notes, note)
		}
	}
	riskScore := riskRound(totalPenalty/riskTotalCap*100, 2)
	level := "none"
	if riskScore >= riskHighMinimum {
		level = "high"
	} else if riskScore >= riskReviewMinimum {
		level = "review"
	}
	assessment := RiskAssessment{
		Version:        riskVersion,
		RiskScore:      riskScore,
		Level:          level,
		Confidence:     riskRound(coverageConfidence*100, 2),
		AppliedPenalty: totalPenalty,
		Signals:        signals,
		Coverage:       coverage,
	}
	return assessment, notes, redFlags, totalPenalty
}
