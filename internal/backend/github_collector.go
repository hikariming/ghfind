package backend

import (
	"context"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GitHubCollector owns the factual, deterministic collection that used to run
// in a Next invocation. It does not use a database or an LLM; the worker owns
// calling it and persisting its resulting ScanResult.
type GitHubCollector struct {
	github *GitHubClient
	clock  func() time.Time
	// cache keeps slow-moving community facts (profiles 30 days, per-repo
	// facts 7 days, outside-PR counts 1 day) across scans in this process.
	cache CollectCache
}

func NewGitHubCollector(client *GitHubClient) *GitHubCollector {
	return &GitHubCollector{github: client, clock: time.Now, cache: NewMemoryCollectCache()}
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
	if user.ID <= 0 || math.IsNaN(user.ID) || math.IsInf(user.ID, 0) || math.Trunc(user.ID) != user.ID || user.ID > 9007199254740991 || user.Login == "" {
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
	external, err := c.github.fetchExternalMergedPRs(ctx, login, externalMergedPRCap)
	if err != nil {
		return ScanResult{}, err
	}
	externalNodes := []mergedPRNode{}
	if external != nil {
		externalNodes = external.Nodes
	}
	mergedAggregationIncomplete := overview.MergedPRCount > 300
	// The newest-300 window plus the separately queried external PRs, so own
	// PR traffic cannot crowd older external work out of the aggregate.
	windowNodes, err := c.github.fetchMergedPRNodes(ctx, login, 300)
	if errors.Is(err, ErrGitHubResourceLimit) {
		mergedAggregationIncomplete = true
		windowNodes = nil
	} else if err != nil {
		return ScanResult{}, err
	}
	mergedContribs := AggregateMergedPRNodes(append(windowNodes, externalNodes...))
	workflowContribs := make([]ContribRepoAgg, 0, len(workflowLanded))
	workflowIDs := map[string]bool{}
	for _, workflow := range workflowLanded {
		workflowIDs[workflow.ID] = true
		workflowContribs = append(workflowContribs, ContribRepoAgg{Repo: workflow.Repo, Stars: workflow.Stars, OwnerLogin: workflow.OwnerLogin, PRs: 1})
	}
	contributions := MergeContribRepoAggs(commitContribs, mergedContribs, workflowContribs)
	signals, err := c.github.fetchImpactRepoSignals(ctx, contributions, loginLower, user.NodeID)
	if err != nil {
		return ScanResult{}, err
	}
	signaledContributions := ApplyImpactRepoSignals(contributions, signals)
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
	attributed := c.github.collectAttributedOriginalRepos(ctx, signaledContributions, organizations, overview.PinnedRepos, loginLower, user.HTMLURL)
	attributedRepoKeys := map[string]bool{}
	for _, repo := range attributed {
		attributedRepoKeys[strings.ToLower(repoDisplayName(repo))] = true
	}
	// Recent merged PRs: a 50-PR report sample from a 100-PR window that also
	// verifies older popular-repo PRs and classifies per-repo code share.
	recentWindow, err := c.github.fetchRecentPRs(ctx, login, 100)
	if err != nil {
		return ScanResult{}, err
	}
	ownedContributions := make([]ContribRepoAgg, 0, len(signaledContributions))
	for _, repo := range signaledContributions {
		if attributedRepoKeys[strings.ToLower(repo.Repo)] {
			repo.AttributedOriginal = true
			for _, a := range attributed {
				if strings.EqualFold(repoDisplayName(a), repo.Repo) {
					repo.AttributionEvidence = a.AttributionEvidence
					repo.AttributionShare = a.AttributionShare
					repo.CoCreatorFacts = a.CoCreatorFacts
					repo.Forks = a.Forks
				}
			}
		}
		if !repo.AttributedOriginal {
			for _, a := range personalOriginal {
				if strings.EqualFold(repoDisplayName(a), repo.Repo) {
					repo.Forks = a.Forks
				}
			}
		}
		ownedContributions = append(ownedContributions, repo)
	}
	// Keep verified organization-maintenance work out of the score-bearing
	// TopRepos set. It enriches representative work and language presentation
	// only; adding it to allOriginal would alter legacy score inputs.
	organizationMaintained := c.github.collectOrganizationMaintainedRepos(ctx, ownedContributions, loginLower, user.HTMLURL)
	allOriginal := dedupeTopRepos(append(personalOriginal, attributed...))
	nonemptyOriginal := 0.0
	for _, repo := range allOriginal {
		if repo.Size > 0 {
			nonemptyOriginal++
		}
	}
	sort.SliceStable(allOriginal, func(i, j int) bool {
		return allOriginal[i].Stars*projectShare(allOriginal[i].AttributionShare) > allOriginal[j].Stars*projectShare(allOriginal[j].AttributionShare)
	})
	topRepos := append(make([]TopRepo, 0, len(allOriginal)), allOriginal...)
	if len(topRepos) > 10 {
		topRepos = topRepos[:10]
	}
	_ = c.github.hydrateTopRepoEvidence(ctx, topRepos, login, 6)
	sort.SliceStable(personalOriginal, func(i, j int) bool { return personalOriginal[i].Stars > personalOriginal[j].Stars })
	_ = c.github.hydrateTopRepoEvidence(ctx, personalOriginal, login, 6)
	for i := range topRepos {
		for _, own := range personalOriginal {
			if strings.EqualFold(repoDisplayName(topRepos[i]), repoDisplayName(own)) {
				topRepos[i] = own
			}
		}
	}
	c.github.hydrateOpenIssueCounts(ctx, topRepos)
	// The profile README repo (<login>/<login>) is a profile page: it never
	// counts toward star totals or stands in as the top-starred project.
	// Rebuilt after hydration so the top repos carry their languages.
	hydrated := map[string]TopRepo{}
	for _, repo := range topRepos {
		hydrated[strings.ToLower(repoDisplayName(repo))] = repo
	}
	starRepos, starTopRepos := []TopRepo{}, []TopRepo{}
	for _, repo := range allOriginal {
		if isProfileReadmeRepo(repo, loginLower) {
			continue
		}
		if top, ok := hydrated[strings.ToLower(repoDisplayName(repo))]; ok {
			repo = top
		}
		starRepos = append(starRepos, repo)
	}
	for _, repo := range topRepos {
		if !isProfileReadmeRepo(repo, loginLower) {
			starTopRepos = append(starTopRepos, repo)
		}
	}
	var engagement *float64
	if len(starTopRepos) > 0 && starTopRepos[0].Stars >= 500 {
		engagement = c.github.fetchRepoEngagementRatio(ctx, valueOrString(starTopRepos[0].OwnerLogin, login), starTopRepos[0].Name)
	}
	bestQuality, bestRepo := BestOriginalRepoQuality(topRepos, loginLower, now)
	topStarredQuality, topStarredRepo := TopStarredOriginalRepoQuality(starTopRepos, loginLower, now)
	personalStarRepos := []TopRepo{}
	personalNonempty := 0.0
	for _, r := range personalOriginal {
		if r.Size > 0 {
			personalNonempty++
		}
		if !isProfileReadmeRepo(r, loginLower) {
			personalStarRepos = append(personalStarRepos, r)
		}
	}
	personalTop := personalOriginal
	if len(personalTop) > 10 {
		personalTop = personalTop[:10]
	}
	personalBest, _ := BestOriginalRepoQuality(personalTop, loginLower, now)
	personalTopQuality, _ := TopStarredOriginalRepoQuality(personalStarRepos, loginLower, now)
	var personalEngagement *float64
	if len(personalStarRepos) > 0 && personalStarRepos[0].Stars >= 500 {
		personalEngagement = c.github.fetchRepoEngagementRatio(ctx, valueOrString(personalStarRepos[0].OwnerLogin, login), personalStarRepos[0].Name)
	}
	personalTotal, personalMax := WeightedOriginalStars(personalStarRepos, now)
	personalShare, personalConfidence := ContentSkillSignals(personalStarRepos)
	contentShare, contentConfidence := ContentSkillSignals(starRepos)
	personalQuality := originalProjectQuality(RawMetrics{WeightedTotalStars: &personalTotal, WeightedMaxStars: &personalMax, ContentSkillStarShare: &personalShare, ContentSkillConfidence: &personalConfidence, NonemptyOriginalRepoCount: personalNonempty, TotalStars: repoStarsTotal(personalStarRepos), MaxStars: repoStarsMax(personalStarRepos), BestOriginalRepoQualityScore: &personalBest, TopStarredOriginalRepoQualityScore: &personalTopQuality, TopRepoEngagementRatio: personalEngagement})
	weightedTotalStars, weightedMaxStars := WeightedOriginalStars(starRepos, now)
	starInflation := false
	if len(starTopRepos) > 0 && starTopRepos[0].Stars >= 100 && starTopRepos[0].Forks/(starTopRepos[0].Stars/100) < 1 && starTopRepos[0].OpenIssues <= 1 {
		starInflation = true
	}

	// Own-project community: outside people building in the user's own repos.
	// Star-inflation suspects get none. Own repos that now qualify through
	// their community (200-999★) get the merge/topic signals the first pass
	// skipped.
	communityFacts, err := c.github.collectOwnRepoCommunities(ctx, ownedContributions, login, organizations, now, c.cache)
	if err != nil {
		return ScanResult{}, err
	}
	for i := range ownedContributions {
		for _, original := range starRepos {
			if strings.EqualFold(repoDisplayName(original), ownedContributions[i].Repo) {
				ownedContributions[i].ContentSkillShare = ContentSkillShare(original)
			}
		}
	}
	communityRepos := ApplyOwnRepoCommunities(ownedContributions, communityFacts, starInflation)
	unsignaled := []ContribRepoAgg{}
	for _, repo := range communityRepos {
		if (valueOrZero(repo.Community) > 0 || hasAttributedCreatorStarCredit(repo, loginLower)) && repo.Topics == nil {
			unsignaled = append(unsignaled, repo)
		}
	}
	if len(unsignaled) > 0 {
		communitySignals, err := c.github.fetchImpactRepoSignals(ctx, unsignaled, loginLower, user.NodeID)
		if err != nil {
			return ScanResult{}, err
		}
		communityRepos = ApplyImpactRepoSignals(communityRepos, communitySignals)
	}
	codeSamples, err := c.github.collectImpactCodeSamples(ctx, communityRepos, login, recentWindow)
	if err != nil {
		return ScanResult{}, err
	}
	contributions = ApplyImpactCodeSamples(communityRepos, codeSamples)

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
	quality := ComputeImpactQualitySignals(recentWindow, impact.ImpactPRCount, loginLower, workflowImpact, contributions)
	verifiedImpact := []RecentPR{}
	for _, pr := range recentWindow {
		if IsEcosystemImpactPR(pr, loginLower, contributions) {
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
	attributedStars := 0.0
	attributedNames := []string{}
	attributedShares := map[string]float64{}
	for _, repo := range attributed {
		attributedStars += repo.Stars * projectShare(repo.AttributionShare)
		attributedNames = append(attributedNames, repoDisplayName(repo))
		attributedShares[strings.ToLower(repoDisplayName(repo))] = projectShare(repo.AttributionShare)
	}

	metrics := RawMetrics{ContentSkillStarShare: &contentShare, ContentSkillConfidence: &contentConfidence, Username: login, GitHubUserID: stringPointer(strconv.FormatFloat(user.ID, 'f', 0, 64)), ProfileURL: user.HTMLURL, AvatarURL: user.AvatarURL, Name: user.Name, Bio: user.Bio, Company: user.Company, AccountAgeYears: accountAgeYears(user.CreatedAt, now), CreatedAt: user.CreatedAt, Followers: user.Followers, Following: user.Following, PublicRepos: user.PublicRepos, FetchedRepoCount: float64(len(repos)), OriginalRepoCount: float64(len(original) + len(attributed)), NonemptyOriginalRepoCount: nonemptyOriginal, ForkRepoCount: float64(len(forks)), EmptyOriginalRepoCount: float64(len(empty)), TotalStars: repoStarsTotal(starRepos), MaxStars: repoStarsMax(starRepos), WeightedTotalStars: floatPointer(weightedTotalStars), WeightedMaxStars: floatPointer(weightedMaxStars), TopRepoEngagementRatio: engagement, AttributedOriginalRepoCount: floatPointer(float64(len(attributed))), AttributedOriginalRepoStars: floatPointer(attributedStars), AttributedOriginalRepos: attributedNames, BestOriginalRepoQualityScore: floatPointer(bestQuality), BestOriginalRepoQualityRepo: bestRepo, TopStarredOriginalRepoQualityScore: floatPointer(topStarredQuality), TopStarredOriginalRepoQualityRepo: topStarredRepo, MergedPRCount: overview.MergedPRCount, WorkflowLandedPRCount: floatPointer(float64(len(workflowLanded))), TotalPRCount: overview.AllPRCount, IssuesCreated: overview.IssuesCreated, LastYearContributions: lastYearContributions, ActivityTypeCount: activityTypeCount(stats, lastYearContributions, overview.AllPRCount, overview.IssuesCreated), ContributionYearsActive: boundedContributionYearsActive(overview.ContributionYears, user.CreatedAt, now), DaysSinceLastActivity: daysSinceActivity, RecentMergedPRSample: float64(len(recentPRs)), RecentTrivialPRCount: trivial, RecentDocLikePRCount: floatPointer(docLike), RecentDocLikePRRatio: floatPointer(ratio(docLike, float64(len(recentPRs)))), RecentExternalPRSample: floatPointer(externalCount), RecentExternalDocLikePRCount: floatPointer(externalDocLike), RecentExternalDocLikePRRatio: floatPointer(ratio(externalDocLike, externalCount)), ExternalTrivialPRCount: externalTrivial, MaxImpactRepoStars: impact.MaxImpactRepoStars, ImpactPrestigeScore: floatPointer(impact.ImpactPrestigeScore), ImpactPRCount: impact.ImpactPRCount, WorkflowLandedImpactPRCount: floatPointer(workflowImpact), ImpactDepthRaw: impact.ImpactDepthRaw, VerifiedImpactPRCount: floatPointer(quality.VerifiedImpactPRCount), CoreImpactPRCount: floatPointer(quality.CoreImpactPRCount), DocLikeImpactPRCount: floatPointer(quality.DocLikeImpactPRCount), UnverifiedImpactPRCount: floatPointer(quality.UnverifiedImpactPRCount), ImpactRepoCount: floatPointer(impact.ImpactRepoCount), ImpactCommitCount: floatPointer(impact.ImpactCommitCount), CommitContributionAggregationUnavailable: commitAggregationUnavailable, MergedPRContributionAggregationIncomplete: mergedAggregationIncomplete, StarInflationSuspect: starInflation, ClosedUnmergedPRCount: closed.ClosedUnmergedPRCount, MaintainerClosedUnmergedPRCount: floatPointer(closed.MaintainerClosedUnmergedPRCount), SelfClosedExternalPRCount: floatPointer(closed.SelfClosedExternalPRCount), SelfClosedOwnRepoPRCount: floatPointer(closed.SelfClosedOwnRepoPRCount), UnknownClosedUnmergedPRCount: floatPointer(closed.UnknownClosedUnmergedPRCount), PRRejectionRate: rejectionRate, RecentPRSample: flood.RecentPRSample, TopRepoPRTarget: flood.TopRepoPRTarget, TopRepoPRShare: flood.TopRepoPRShare, TemplatedPRRatio: flood.TemplatedPRRatio, PRFloodSuspect: flood.PRFloodSuspect}
	metrics.PersonalOriginalProjectQualityScore = &personalQuality
	metrics.AttributedOriginalRepoShares = attributedShares
	applyPresentationSignals(&metrics, recentPRs, login, attributedNames)
	// Calculate the deterministic score before any presentation-only language
	// enrichment, so the score path cannot observe or depend on that work.
	if external != nil {
		attributedPRs := 0.0
		for _, repo := range contributions {
			if repo.AttributedOriginal && !strings.EqualFold(repo.OwnerLogin, loginLower) {
				attributedPRs += repo.PRs * projectShare(repo.AttributionShare)
			}
		}
		externalCount := max(0, min(external.Total, overview.MergedPRCount)-attributedPRs)
		metrics.ExternalMergedPRCount = floatPointer(externalCount)
		externalNodes := []mergedPRNode{}
		for _, node := range external.Nodes {
			if node.Repository != nil && !attributedRepoKeys[strings.ToLower(node.Repository.NameWithOwner)] {
				externalNodes = append(externalNodes, node)
			}
		}
		metrics.ExternalHighStarPRShare = floatPointer(highStarPRShare(externalNodes))
		metrics.OwnPRCommunity = floatPointer(OwnPRCommunityShare(contributions, loginLower, overview.MergedPRCount-externalCount))
	}
	metrics.Pronouns = overview.Pronouns
	scoring := Score(metrics)
	estimatedContributionLanguages := c.github.collectEstimatedContributionLanguages(ctx, ownedContributions)
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
		total += max(0, repo.Stars) * projectShare(repo.AttributionShare)
	}
	return total
}

func repoStarsMax(repos []TopRepo) float64 {
	maximum := 0.0
	for _, repo := range repos {
		maximum = max(maximum, repo.Stars*projectShare(repo.AttributionShare))
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
