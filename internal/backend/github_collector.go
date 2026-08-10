package backend

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"
)

// GitHubCollector owns the factual, deterministic collection that used to run
// in a Next invocation. It does not use a database or an LLM; the worker owns
// calling it and persisting its resulting ScanResult.
type GitHubCollector struct {
	github *GitHubClient
	clock  func() time.Time
}

func NewGitHubCollector(client *GitHubClient) *GitHubCollector {
	return &GitHubCollector{github: client, clock: time.Now}
}

func (c *GitHubCollector) Collect(ctx context.Context, username string) (ScanResult, error) {
	if c == nil || c.github == nil || !c.github.HasToken() {
		return ScanResult{}, ErrGitHubAuthRequired
	}
	now := c.clock().UTC()
	user, err := c.github.GetUser(ctx, username)
	if err != nil {
		return ScanResult{}, err
	}
	if user.ID == 0 || user.Login == "" {
		return ScanResult{}, ErrGitHubAccountNotFound
	}
	login, loginLower := user.Login, strings.ToLower(user.Login)
	repos := []githubRepo{}
	for _, page := range []int{1, 2} {
		chunk, err := c.github.ListUserRepos(ctx, username, page)
		if err != nil {
			return ScanResult{}, err
		}
		if len(chunk) == 0 {
			break
		}
		repos = append(repos, chunk...)
		if len(chunk) < 100 {
			break
		}
	}
	overview, stats, lastYearContributions, err := c.github.fetchContributionOverview(ctx, username)
	if err != nil {
		return ScanResult{}, err
	}
	// Public events are deliberately best-effort in the Node implementation.
	latestEvent, _ := c.github.LatestPublicActivity(ctx, username)

	commitContribs, err := c.github.fetchCommitContribReposByYear(ctx, login, overview.ContributionYears)
	if err != nil && !errors.Is(err, ErrGitHubResourceLimit) {
		return ScanResult{}, err
	}
	commitAggregationUnavailable := len(overview.ContributionYears) > 0 && commitContribs == nil
	workflowLanded, _ := c.github.fetchWorkflowLandedPRs(ctx, login, overview.ClosedPRCount)
	mergedContribs := []ContribRepoAgg{}
	mergedAggregationIncomplete := overview.MergedPRCount > 300
	if !mergedAggregationIncomplete {
		mergedContribs, err = c.github.fetchMergedPRContribRepos(ctx, login, 300)
		if errors.Is(err, ErrGitHubResourceLimit) {
			mergedAggregationIncomplete = true
			mergedContribs = nil
		} else if err != nil {
			return ScanResult{}, err
		}
	}
	workflowContribs := make([]ContribRepoAgg, 0, len(workflowLanded))
	workflowIDs := map[string]bool{}
	for _, workflow := range workflowLanded {
		workflowIDs[workflow.ID] = true
		workflowContribs = append(workflowContribs, ContribRepoAgg{Repo: workflow.Repo, Stars: workflow.Stars, OwnerLogin: workflow.OwnerLogin, PRs: 1})
	}
	contributions := MergeContribRepoAggs(commitContribs, mergedContribs, workflowContribs)
	organizations, err := c.github.fetchOrganizations(ctx, login)
	if err != nil {
		return ScanResult{}, err
	}

	original, forks, empty := []githubRepo{}, []githubRepo{}, []githubRepo{}
	for _, repo := range repos {
		if repo.Fork {
			forks = append(forks, repo)
			continue
		}
		original = append(original, repo)
		if repo.Size == 0 {
			empty = append(empty, repo)
		}
	}
	personalOriginal := make([]TopRepo, 0, len(original))
	for _, repo := range original {
		personalOriginal = append(personalOriginal, topRepoFromGitHub(repo, login, false, nil))
	}
	attributed := c.github.collectAttributedOriginalRepos(ctx, contributions, organizations, overview.PinnedRepos, loginLower, user.HTMLURL)
	// Keep verified organization-maintenance work out of the score-bearing
	// TopRepos set. It enriches representative work and language presentation
	// only; adding it to allOriginal would alter legacy score inputs.
	organizationMaintained := c.github.collectOrganizationMaintainedRepos(ctx, contributions, loginLower, user.HTMLURL)
	allOriginal := dedupeTopRepos(append(personalOriginal, attributed...))
	nonemptyOriginal := 0.0
	for _, repo := range allOriginal {
		if repo.Size > 0 {
			nonemptyOriginal++
		}
	}
	sort.SliceStable(allOriginal, func(i, j int) bool { return allOriginal[i].Stars > allOriginal[j].Stars })
	topRepos := append(make([]TopRepo, 0, len(allOriginal)), allOriginal...)
	if len(topRepos) > 10 {
		topRepos = topRepos[:10]
	}
	_ = c.github.hydrateTopRepoEvidence(ctx, topRepos, login, 6)
	c.github.hydrateOpenIssueCounts(ctx, topRepos)
	var engagement *float64
	if len(topRepos) > 0 && topRepos[0].Stars >= 500 {
		engagement = c.github.fetchRepoEngagementRatio(ctx, valueOrString(topRepos[0].OwnerLogin, login), topRepos[0].Name)
	}
	bestQuality, bestRepo := BestOriginalRepoQuality(topRepos, loginLower, now)
	topStarredQuality, topStarredRepo := TopStarredOriginalRepoQuality(topRepos, loginLower, now)

	recentWindow, err := c.github.fetchRecentPRs(ctx, login, 100)
	if err != nil {
		return ScanResult{}, err
	}
	recentPRs := append(make([]RecentPR, 0, len(recentWindow)), recentWindow...)
	if len(recentPRs) > 50 {
		recentPRs = recentPRs[:50]
	}
	allPRs, err := c.github.fetchRecentAllPRs(ctx, login, 30)
	if err != nil {
		return ScanResult{}, err
	}
	flood := ComputeFloodSignals(allPRs, loginLower)
	impact := ComputeImpactFromContribMap(contributions, loginLower)
	workflowImpact := 0.0
	for _, workflow := range workflowLanded {
		if (strings.EqualFold(workflow.OwnerLogin, loginLower) && workflow.Stars >= 1000) || (!strings.EqualFold(workflow.OwnerLogin, loginLower) && workflow.Stars >= 200) {
			workflowImpact++
		}
	}
	quality := ComputeImpactQualitySignals(recentWindow, impact.ImpactPRCount, loginLower, workflowImpact)
	verifiedImpact := []RecentPR{}
	for _, pr := range recentWindow {
		if IsEcosystemImpactPR(pr, loginLower) {
			verifiedImpact = append(verifiedImpact, trimRecentPR(pr))
			if len(verifiedImpact) == 12 {
				break
			}
		}
	}
	trivial, docLike, externalDocLike, externalCount, externalTrivial := 0.0, 0.0, 0.0, 0.0, 0.0
	for _, pr := range recentPRs {
		if pr.Trivial {
			trivial++
		}
		if IsDocLikeImpactPR(pr) {
			docLike++
		}
		isExternal := pr.Repo != nil && repoOwner(*pr.Repo) != loginLower
		if isExternal {
			externalCount++
			if IsDocLikeImpactPR(pr) {
				externalDocLike++
			}
		}
		if IsExternalTrivialFarmPR(pr, loginLower) {
			externalTrivial++
		}
	}
	lastActivity := latestEvent
	for _, repo := range repos {
		if pushed, ok := parseTimestamp(repo.PushedAt); ok && (lastActivity == nil || pushed.After(*lastActivity)) {
			copy := pushed
			lastActivity = &copy
		}
	}
	var daysSinceActivity *float64
	if lastActivity != nil {
		days := max(0, float64(int(now.Sub(*lastActivity).Hours()/24)))
		daysSinceActivity = &days
	}
	closed := ComputeClosedPRBreakdown(overview.ClosedPRNodes, overview.ClosedPRCount, loginLower, workflowIDs)
	decided := overview.MergedPRCount + closed.MaintainerClosedUnmergedPRCount
	rejectionRate := 0.0
	if decided > 0 {
		rejectionRate = roundJS(closed.MaintainerClosedUnmergedPRCount/decided*100) / 100
	}
	starInflation := false
	if len(topRepos) > 0 && topRepos[0].Stars >= 100 && topRepos[0].Forks/(topRepos[0].Stars/100) < 1 && topRepos[0].OpenIssues <= 1 {
		starInflation = true
	}
	attributedStars := 0.0
	attributedNames := []string{}
	for _, repo := range attributed {
		attributedStars += repo.Stars
		attributedNames = append(attributedNames, repoDisplayName(repo))
	}

	metrics := RawMetrics{Username: login, ProfileURL: user.HTMLURL, AvatarURL: user.AvatarURL, Name: user.Name, Bio: user.Bio, Company: user.Company, AccountAgeYears: accountAgeYears(user.CreatedAt, now), CreatedAt: user.CreatedAt, Followers: user.Followers, Following: user.Following, PublicRepos: user.PublicRepos, FetchedRepoCount: float64(len(repos)), OriginalRepoCount: float64(len(original) + len(attributed)), NonemptyOriginalRepoCount: nonemptyOriginal, ForkRepoCount: float64(len(forks)), EmptyOriginalRepoCount: float64(len(empty)), TotalStars: repoStarsTotal(allOriginal), MaxStars: repoStarsMax(allOriginal), TopRepoEngagementRatio: engagement, AttributedOriginalRepoCount: floatPointer(float64(len(attributed))), AttributedOriginalRepoStars: floatPointer(attributedStars), AttributedOriginalRepos: attributedNames, BestOriginalRepoQualityScore: floatPointer(bestQuality), BestOriginalRepoQualityRepo: bestRepo, TopStarredOriginalRepoQualityScore: floatPointer(topStarredQuality), TopStarredOriginalRepoQualityRepo: topStarredRepo, MergedPRCount: overview.MergedPRCount, WorkflowLandedPRCount: floatPointer(float64(len(workflowLanded))), TotalPRCount: overview.AllPRCount, IssuesCreated: overview.IssuesCreated, LastYearContributions: lastYearContributions, ActivityTypeCount: activityTypeCount(stats, lastYearContributions, overview.AllPRCount, overview.IssuesCreated), ContributionYearsActive: boundedContributionYearsActive(overview.ContributionYears, user.CreatedAt, now), DaysSinceLastActivity: daysSinceActivity, RecentMergedPRSample: float64(len(recentPRs)), RecentTrivialPRCount: trivial, RecentDocLikePRCount: floatPointer(docLike), RecentDocLikePRRatio: floatPointer(ratio(docLike, float64(len(recentPRs)))), RecentExternalPRSample: floatPointer(externalCount), RecentExternalDocLikePRCount: floatPointer(externalDocLike), RecentExternalDocLikePRRatio: floatPointer(ratio(externalDocLike, externalCount)), ExternalTrivialPRCount: externalTrivial, MaxImpactRepoStars: impact.MaxImpactRepoStars, ImpactPrestigeScore: floatPointer(impact.ImpactPrestigeScore), ImpactPRCount: impact.ImpactPRCount, WorkflowLandedImpactPRCount: floatPointer(workflowImpact), ImpactDepthRaw: impact.ImpactDepthRaw, ImpactQualityCap: quality.ImpactQualityCap, VerifiedImpactPRCount: floatPointer(quality.VerifiedImpactPRCount), CoreImpactPRCount: floatPointer(quality.CoreImpactPRCount), DocLikeImpactPRCount: floatPointer(quality.DocLikeImpactPRCount), UnverifiedImpactPRCount: floatPointer(quality.UnverifiedImpactPRCount), ImpactRepoCount: floatPointer(impact.ImpactRepoCount), ImpactCommitCount: floatPointer(impact.ImpactCommitCount), CommitContributionAggregationUnavailable: commitAggregationUnavailable, MergedPRContributionAggregationIncomplete: mergedAggregationIncomplete, StarInflationSuspect: starInflation, ClosedUnmergedPRCount: closed.ClosedUnmergedPRCount, MaintainerClosedUnmergedPRCount: floatPointer(closed.MaintainerClosedUnmergedPRCount), SelfClosedExternalPRCount: floatPointer(closed.SelfClosedExternalPRCount), SelfClosedOwnRepoPRCount: floatPointer(closed.SelfClosedOwnRepoPRCount), UnknownClosedUnmergedPRCount: floatPointer(closed.UnknownClosedUnmergedPRCount), PRRejectionRate: rejectionRate, RecentPRSample: flood.RecentPRSample, TopRepoPRTarget: flood.TopRepoPRTarget, TopRepoPRShare: flood.TopRepoPRShare, TemplatedPRRatio: flood.TemplatedPRRatio, PRFloodSuspect: flood.PRFloodSuspect}
	// Calculate the deterministic score before any presentation-only language
	// enrichment, so the score path cannot observe or depend on that work.
	scoring := Score(metrics)
	estimatedContributionLanguages := c.github.collectEstimatedContributionLanguages(ctx, contributions)
	signatureWork := BuildRecentSignatureWork(impact.ImpactRepos, recentPRs)
	signatureWork.OrganizationMaintainedRepos = organizationMaintained
	signatureWork.EstimatedContributionLanguages = estimatedContributionLanguages
	return ScanResult{Metrics: metrics, TopRepos: topRepos, RecentPRs: recentPRs, FloodPRTitles: flood.FloodPRTitles, ImpactRepos: impact.ImpactRepos, VerifiedImpactPRs: verifiedImpact, SignatureWork: signatureWork, PinnedRepos: overview.PinnedRepos, Organizations: organizations, Scoring: scoring}, nil
}

func floatPointer(value float64) *float64 { return &value }

func dedupeTopRepos(repos []TopRepo) []TopRepo {
	seen := map[string]bool{}
	result := []TopRepo{}
	for _, repo := range repos {
		key := strings.ToLower(repoDisplayName(repo))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, repo)
	}
	return result
}

func repoStarsTotal(repos []TopRepo) float64 {
	total := 0.0
	for _, repo := range repos {
		total += max(0, repo.Stars)
	}
	return total
}

func repoStarsMax(repos []TopRepo) float64 {
	maximum := 0.0
	for _, repo := range repos {
		maximum = max(maximum, repo.Stars)
	}
	return maximum
}

func ratio(numerator, denominator float64) float64 {
	if denominator <= 0 {
		return 0
	}
	return roundJS(numerator/denominator*100) / 100
}

func trimRecentPR(pr RecentPR) RecentPR {
	if pr.Title != nil {
		runes := []rune(*pr.Title)
		if len(runes) > 200 {
			value := string(runes[:200])
			pr.Title = &value
		}
	}
	if len(pr.Files) > 20 {
		pr.Files = pr.Files[:20]
	}
	return pr
}
