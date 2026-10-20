package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Own-project community score: a per-repo 0..1 signal built from what OTHER
// people do in the user's own projects (established outside contributors,
// retention, demand, responsiveness, forks, recency). It never uses stars.
// Mirrors the community section of src/lib/github.ts; shared fixtures pin both.

type CommunityProfile struct {
	Login     string   `json:"login"`
	CreatedAt *string  `json:"created_at"`
	Followers float64  `json:"followers"`
	MergedPRs float64  `json:"merged_prs"`
	Orgs      []string `json:"orgs"`
}

type CommunityContributor struct {
	Login         string  `json:"login"`
	Type          string  `json:"type"`
	Contributions float64 `json:"contributions"`
}

type CommunityPRSample struct {
	Author     *string  `json:"author"`
	AuthorType *string  `json:"author_type"`
	CreatedAt  string   `json:"created_at"`
	MergedAt   string   `json:"merged_at"`
	Title      *string  `json:"title"`
	Churn      float64  `json:"churn"`
	Files      []string `json:"files"`
}

type CommunityIssueSample struct {
	Author     *string  `json:"author"`
	AuthorType *string  `json:"author_type"`
	CreatedAt  string   `json:"created_at"`
	Commenters []string `json:"commenters"`
}

type OwnRepoCommunityRaw struct {
	Repo                string                 `json:"repo"`
	Forks               float64                `json:"forks"`
	MergedTotal         float64                `json:"merged_total"`
	ClosedUnmergedTotal float64                `json:"closed_unmerged_total"`
	PRsOpenedTotal      float64                `json:"prs_opened_total"`
	IssuesTotal         float64                `json:"issues_total"`
	Contributors        []CommunityContributor `json:"contributors"`
	Merged              []CommunityPRSample    `json:"merged"`
	Issues              []CommunityIssueSample `json:"issues"`
}

type OwnRepoCommunityContext struct {
	Login        string                      `json:"login"`
	OwnerOrgs    []string                    `json:"owner_orgs"`
	Attributed   bool                        `json:"attributed"`
	MutualOwners []string                    `json:"mutual_owners"`
	Profiles     map[string]CommunityProfile `json:"profiles"`
	Now          string                      `json:"now"`
}

type OwnRepoCommunityFacts struct {
	WeightedContributors  float64  `json:"weighted_contributors"`
	SustainedContributors float64  `json:"sustained_contributors"`
	OutsideDemand         float64  `json:"outside_demand"`
	MergeLatencyDays      *float64 `json:"merge_latency_days"`
	OwnerResponseShare    float64  `json:"owner_response_share"`
	OutsideAcceptance     float64  `json:"outside_acceptance"`
	Forks                 float64  `json:"forks"`
	OutsideMergedPRs      float64  `json:"outside_merged_prs"`
	DaysSinceOutsideMerge *float64 `json:"days_since_outside_merge"`
	LeadShare             float64  `json:"lead_share"`
}

const (
	communityDayMillis           = 24 * 60 * 60 * 1000
	communityEstablishedDays     = 90
	communityMinFollowers        = 10
	communityMinOutsideMergedPRs = 3
	communitySustainedCommits    = 5
	communityResponseMinAgeDays  = 3
	communityContributorsFullAt  = 30
	communitySustainedFullAt     = 10
	communityDemandFullAt        = 300
	communityForksFullAt         = 1000
	communityLatencyZeroDays     = 60
	communityRecentDays          = 90
	communityStaleDays           = 730
	communityRepoCap             = 3
	communityPRSamplePages       = 3
	communityPRPage              = 20
	communityIssueSample         = 30
	communityProfileBatch        = 15
	communityProfileConcurrency  = 4
	communityRESTFloor           = 300
	communityGraphQLFloor        = 500
	communityCacheVersion        = "v2"
	communityProfileTTL          = 30 * 24 * time.Hour
	communityFactsTTL            = 7 * 24 * time.Hour
	communityCountsTTL           = 24 * time.Hour
	ownRepoImpactMinStars        = 1000
)

// Runtime vars, not constants, so mixed arithmetic is evaluated in float64
// exactly like the TypeScript collector.
var (
	communityStaleFloor   = 0.4
	communityMutualWeight = 0.5
	communityDepth        = 2.5
)

var communityBotLoginRE = regexp.MustCompile(`(?i)\[bot\]$|-bot$|^bot-|^(renovate|dependabot|github-actions|greenkeeper|snyk-bot|codecov|allcontributors)`)

func round4(value float64) float64 { return roundJS(value*10000) / 10000 }

func isCommunityBot(login, typ *string) bool {
	return login == nil || *login == "" || (typ != nil && *typ != "User") || communityBotLoginRE.MatchString(*login)
}

func parseMillis(value string) (int64, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return 0, false
	}
	return parsed.UnixMilli(), true
}

func isEstablishedAccount(profile *CommunityProfile, at string, seenHere float64) bool {
	if profile == nil || profile.CreatedAt == nil {
		return false
	}
	created, ok := parseMillis(*profile.CreatedAt)
	acted, ok2 := parseMillis(at)
	if !ok || !ok2 {
		return false
	}
	if acted-created < communityEstablishedDays*communityDayMillis {
		return false
	}
	return profile.Followers >= communityMinFollowers || profile.MergedPRs-seenHere >= communityMinOutsideMergedPRs
}

// ComputeOwnRepoCommunityFacts mirrors computeOwnRepoCommunityFacts.
func ComputeOwnRepoCommunityFacts(raw OwnRepoCommunityRaw, ctx OwnRepoCommunityContext) OwnRepoCommunityFacts {
	loginLower := strings.ToLower(ctx.Login)
	owner := repoOwner(raw.Repo)
	insiderOrgs := map[string]bool{}
	for _, org := range ctx.OwnerOrgs {
		insiderOrgs[strings.ToLower(org)] = true
	}
	if ctx.Attributed && owner != "" {
		insiderOrgs[owner] = true
	}
	mutual := map[string]bool{}
	for _, mutualOwner := range ctx.MutualOwners {
		mutual[strings.ToLower(mutualOwner)] = true
	}
	profileOf := func(login *string) *CommunityProfile {
		if login == nil {
			return nil
		}
		if profile, ok := ctx.Profiles[strings.ToLower(*login)]; ok {
			return &profile
		}
		return nil
	}
	isInsider := func(login *string) bool {
		profile := profileOf(login)
		if profile == nil {
			return false
		}
		for _, org := range profile.Orgs {
			if insiderOrgs[strings.ToLower(org)] {
				return true
			}
		}
		return false
	}
	nowMillis, _ := parseMillis(ctx.Now)

	seen := map[string]float64{}
	for _, pr := range raw.Merged {
		if pr.Author != nil {
			seen[strings.ToLower(*pr.Author)]++
		}
	}
	kept := []CommunityPRSample{}
	trivial := 0.0
	for _, pr := range raw.Merged {
		if isCommunityBot(pr.Author, pr.AuthorType) || strings.ToLower(*pr.Author) == loginLower {
			continue
		}
		if isInsider(pr.Author) {
			continue
		}
		if !isEstablishedAccount(profileOf(pr.Author), pr.CreatedAt, seen[strings.ToLower(*pr.Author)]) {
			continue
		}
		repo := raw.Repo
		asPR := RecentPR{Title: pr.Title, Repo: &repo, Churn: pr.Churn, ChangedFiles: float64(len(pr.Files)), Trivial: pr.Churn <= 5, Files: pr.Files}
		if asPR.Trivial || IsDocLikeImpactPR(asPR) {
			trivial++
			continue
		}
		kept = append(kept, pr)
	}
	decided := float64(len(kept)) + trivial
	substantiveShare := 0.5
	if decided > 0 {
		substantiveShare = max(0.5, float64(len(kept))/decided)
	}

	weighted, sustained, topCommits, userCommits := 0.0, 0.0, 0.0, 0.0
	contributors := map[string]CommunityContributor{}
	for _, c := range raw.Contributors {
		contributors[strings.ToLower(c.Login)] = c
	}
	outsideMerged := 0.0
	for _, pr := range raw.Merged {
		if isCommunityBot(pr.Author, pr.AuthorType) || strings.EqualFold(*pr.Author, loginLower) {
			continue
		}
		outsideMerged++
		lower := strings.ToLower(*pr.Author)
		c := contributors[lower]
		c.Login, c.Type = *pr.Author, "User"
		c.Contributions = max(c.Contributions, seen[lower])
		contributors[lower] = c
	}
	// Sort so float accumulation is deterministic across languages.
	keys := make([]string, 0, len(contributors))
	for key := range contributors {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		contributor := contributors[key]
		login, typ := contributor.Login, contributor.Type
		lower := strings.ToLower(login)
		if isCommunityBot(&login, &typ) {
			continue
		}
		topCommits = max(topCommits, contributor.Contributions)
		if lower == loginLower {
			userCommits = contributor.Contributions
			continue
		}
		if isInsider(&login) || !isEstablishedAccount(profileOf(&login), ctx.Now, seen[lower]) {
			continue
		}
		weight := 1.0
		if mutual[lower] {
			weight = communityMutualWeight
		}
		weighted += LogRatio(contributor.Contributions, 10) * weight
		if contributor.Contributions >= communitySustainedCommits {
			sustained++
		}
	}

	keptIssues := []CommunityIssueSample{}
	for _, issue := range raw.Issues {
		if isCommunityBot(issue.Author, issue.AuthorType) || strings.ToLower(*issue.Author) == loginLower || isInsider(issue.Author) {
			continue
		}
		if isEstablishedAccount(profileOf(issue.Author), issue.CreatedAt, 0) {
			keptIssues = append(keptIssues, issue)
		}
	}
	issueShare, prShare := 0.0, 0.0
	if len(raw.Issues) > 0 {
		issueShare = float64(len(keptIssues)) / float64(len(raw.Issues))
	}
	if len(raw.Merged) > 0 {
		prShare = float64(len(kept)) / float64(len(raw.Merged))
	}
	demand := raw.IssuesTotal*issueShare + raw.PRsOpenedTotal*prShare

	latencies := []float64{}
	lastMerge := int64(0)
	for _, pr := range kept {
		merged, _ := parseMillis(pr.MergedAt)
		created, _ := parseMillis(pr.CreatedAt)
		latencies = append(latencies, float64(merged-created)/communityDayMillis)
		if merged > lastMerge {
			lastMerge = merged
		}
	}
	sort.Float64s(latencies)
	var latency *float64
	if count := len(latencies); count > 0 {
		mid := count >> 1
		value := latencies[mid]
		if count%2 == 0 {
			value = (latencies[mid-1] + latencies[mid]) / 2
		}
		rounded := round4(value)
		latency = &rounded
	}
	answerable, answered := 0.0, 0.0
	for _, issue := range keptIssues {
		created, _ := parseMillis(issue.CreatedAt)
		if nowMillis-created <= communityResponseMinAgeDays*communityDayMillis {
			continue
		}
		answerable++
		for _, commenter := range issue.Commenters {
			if strings.ToLower(commenter) == loginLower {
				answered++
				break
			}
		}
	}
	facts := OwnRepoCommunityFacts{
		WeightedContributors:  round4(weighted * substantiveShare),
		SustainedContributors: sustained,
		OutsideDemand:         round4(demand),
		MergeLatencyDays:      latency,
		Forks:                 raw.Forks,
		OutsideMergedPRs:      outsideMerged,
		LeadShare:             1,
	}
	if answerable > 0 {
		facts.OwnerResponseShare = round4(answered / answerable)
	}
	if decidedPRs := raw.MergedTotal + raw.ClosedUnmergedTotal; decidedPRs > 0 {
		facts.OutsideAcceptance = round4(raw.MergedTotal / decidedPRs)
	}
	if lastMerge > 0 {
		days := round4(max(0, float64(nowMillis-lastMerge)) / communityDayMillis)
		facts.DaysSinceOutsideMerge = &days
	}
	if ctx.Attributed {
		facts.LeadShare = 0
		if topCommits > 0 {
			facts.LeadShare = round4(min(1, userCommits/topCommits))
		}
	}
	return facts
}

// OwnRepoCommunity mirrors ownRepoCommunity.
func OwnRepoCommunity(f OwnRepoCommunityFacts) float64 {
	contributors := LogRatio(f.WeightedContributors, communityContributorsFullAt)
	retention := LogRatio(f.SustainedContributors, communitySustainedFullAt)
	demand := LogRatio(f.OutsideDemand, communityDemandFullAt)
	latencyScore := 0.0
	if f.MergeLatencyDays != nil {
		latencyScore = max(0, min(1, 1-math.Log10(max(*f.MergeLatencyDays, 1))/math.Log10(communityLatencyZeroDays)))
	}
	responsiveness := 0.5*latencyScore + 0.25*f.OwnerResponseShare + 0.25*f.OutsideAcceptance
	forks := LogRatio(f.Forks, communityForksFullAt)
	recency := communityStaleFloor
	if days := f.DaysSinceOutsideMerge; days != nil && *days < communityStaleDays {
		if *days <= communityRecentDays {
			recency = 1
		} else {
			recency = 1 - (1-communityStaleFloor)*((*days-communityRecentDays)/(communityStaleDays-communityRecentDays))
		}
	}
	modulators := (retention + demand + responsiveness + forks) / 4
	return round4(max(0, min(1, f.LeadShare)) * recency * contributors * (0.6 + 0.4*modulators))
}

// OwnPRCommunityShare mirrors ownPrCommunityShare.
func OwnPRCommunityShare(repos []ContribRepoAgg, loginLower string, ownPRs float64) float64 {
	if ownPRs <= 0 {
		return 0
	}
	weighted := 0.0
	for _, repo := range repos {
		if isOwnImpactRepo(repo, loginLower) && !repo.IsFork && valueOrZero(repo.Community) > 0 {
			weighted += repo.PRs * valueOrZero(repo.Community)
		}
	}
	return round4(max(0, min(1, weighted/ownPRs)))
}

// CommunityCandidates mirrors communityCandidates.
func CommunityCandidates(repos []ContribRepoAgg, loginLower string) []ContribRepoAgg {
	candidates := []ContribRepoAgg{}
	for _, repo := range repos {
		if !repo.IsPrivate && !repo.IsFork && strings.Contains(repo.Repo, "/") && repo.Stars >= 200 && repo.Commits+repo.PRs > 0 &&
			(repo.AttributedOriginal || strings.EqualFold(repo.OwnerLogin, loginLower)) {
			candidates = append(candidates, repo)
		}
	}
	return candidates
}

func contributedRepoOwners(repos []ContribRepoAgg, loginLower string) []string {
	set := map[string]bool{}
	for _, repo := range repos {
		if repo.Commits+repo.PRs > 0 && !repo.AttributedOriginal && !strings.EqualFold(repo.OwnerLogin, loginLower) {
			set[strings.ToLower(repo.OwnerLogin)] = true
		}
	}
	owners := make([]string, 0, len(set))
	for owner := range set {
		owners = append(owners, owner)
	}
	sort.Strings(owners)
	return owners
}

// ApplyOwnRepoCommunities mirrors applyOwnRepoCommunities.
func ApplyOwnRepoCommunities(repos []ContribRepoAgg, facts map[string]OwnRepoCommunityFacts, starInflationSuspect bool) []ContribRepoAgg {
	result := make([]ContribRepoAgg, 0, len(repos))
	for _, repo := range repos {
		repo.StarInflationSuspect = starInflationSuspect
		if f, ok := facts[strings.ToLower(repo.Repo)]; ok {
			copied := f
			repo.CommunityFacts = &copied
			repo.StarInflationSeverity = floatPointer(impactStarSeverity(repo))
			community := OwnRepoCommunity(f) * impactStarDiscount(repo)
			repo.Community = &community
		}
		repo.StarInflationSeverity = floatPointer(impactStarSeverity(repo))
		result = append(result, repo)
	}
	return result
}

// CollectCache is a best-effort cache for slow-moving collector facts.
type CollectCache interface {
	Get(ctx context.Context, key string) ([]byte, bool)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration)
}

type memoryCollectCache struct {
	mu      sync.Mutex
	entries map[string]memoryCollectEntry
	now     func() time.Time
}

type memoryCollectEntry struct {
	value   []byte
	expires time.Time
}

// NewMemoryCollectCache returns a process-local TTL cache; the long-lived
// worker keeps profiles and per-repo community facts across scans.
func NewMemoryCollectCache() CollectCache {
	return &memoryCollectCache{entries: map[string]memoryCollectEntry{}, now: time.Now}
}

func (c *memoryCollectCache) Get(_ context.Context, key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok || !c.now().Before(entry.expires) {
		delete(c.entries, key)
		return nil, false
	}
	return entry.value, true
}

func (c *memoryCollectCache) Set(_ context.Context, key string, value []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) > 50000 {
		for entryKey, entry := range c.entries {
			if !c.now().Before(entry.expires) {
				delete(c.entries, entryKey)
			}
		}
	}
	c.entries[key] = memoryCollectEntry{value: value, expires: c.now().Add(ttl)}
}

func cacheGetJSON(ctx context.Context, cache CollectCache, key string, out any) bool {
	if cache == nil {
		return false
	}
	value, ok := cache.Get(ctx, key)
	return ok && json.Unmarshal(value, out) == nil
}

func cacheSetJSON(ctx context.Context, cache CollectCache, key string, value any, ttl time.Duration) {
	if cache == nil {
		return
	}
	if encoded, err := json.Marshal(value); err == nil {
		cache.Set(ctx, key, encoded, ttl)
	}
}

var errCommunityBudget = errors.New("community collection budget exhausted")

const communityGraphQLAttempts = 3

type graphRateLimit struct {
	Remaining *float64 `json:"remaining"`
}

func checkCommunityGraphQLBudget(rateLimit *graphRateLimit) error {
	if rateLimit != nil && rateLimit.Remaining != nil && *rateLimit.Remaining < communityGraphQLFloor {
		return errCommunityBudget
	}
	return nil
}

// communityGraphQL retries transient GraphQL failures (502s, timeouts): one
// failed sample would otherwise leave a repo's community unmeasured and swing
// the score between scans. Rate limits and missing auth are not retried.
func (c *GitHubClient) communityGraphQL(ctx context.Context, query string, variables map[string]any, out any) error {
	var err error
	for attempt := 0; attempt < communityGraphQLAttempts; attempt++ {
		if err = c.graphql(ctx, query, variables, out); err == nil || errors.Is(err, ErrGitHubRateLimited) || errors.Is(err, ErrGitHubAuthRequired) {
			return err
		}
		if attempt < communityGraphQLAttempts-1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt+1) * time.Second):
			}
		}
	}
	return err
}

func (c *GitHubClient) fetchCommunityCounts(ctx context.Context, candidates []ContribRepoAgg, login string, cache CollectCache) (map[string]float64, error) {
	key := "community:counts:" + communityCacheVersion + ":" + strings.ToLower(login)
	cached := map[string]float64{}
	if cacheGetJSON(ctx, cache, key, &cached) {
		complete := true
		for _, repo := range candidates {
			if _, ok := cached[strings.ToLower(repo.Repo)]; !ok {
				complete = false
				break
			}
		}
		if complete {
			return cached, nil
		}
	}
	counts := map[string]float64{}
	for start := 0; start < len(candidates); start += 10 {
		end := start + 10
		if end > len(candidates) {
			end = len(candidates)
		}
		chunk := candidates[start:end]
		declarations, aliases := []string{}, []string{}
		variables := map[string]any{}
		for index, repo := range chunk {
			declarations = append(declarations, fmt.Sprintf("$q%d: String!", index))
			aliases = append(aliases, fmt.Sprintf("c%d: search(query: $q%d, type: ISSUE, first: 0) { issueCount }", index, index))
			variables[fmt.Sprintf("q%d", index)] = "repo:" + repo.Repo + " is:pr is:merged -author:" + login
		}
		var result map[string]json.RawMessage
		if err := c.communityGraphQL(ctx, "query("+strings.Join(declarations, ", ")+") { rateLimit { remaining } "+strings.Join(aliases, " ")+" }", variables, &result); err != nil {
			return nil, err
		}
		var rateLimit graphRateLimit
		_ = json.Unmarshal(result["rateLimit"], &rateLimit)
		if err := checkCommunityGraphQLBudget(&rateLimit); err != nil {
			return nil, err
		}
		for index, repo := range chunk {
			var count struct {
				IssueCount float64 `json:"issueCount"`
			}
			_ = json.Unmarshal(result[fmt.Sprintf("c%d", index)], &count)
			counts[strings.ToLower(repo.Repo)] = count.IssueCount
		}
	}
	cacheSetJSON(ctx, cache, key, counts, communityCountsTTL)
	return counts, nil
}

type communityAuthorNode struct {
	Typename *string `json:"__typename"`
	Login    *string `json:"login"`
}

func (c *GitHubClient) fetchOwnRepoCommunityRaw(ctx context.Context, repo, login string) (OwnRepoCommunityRaw, error) {
	raw := OwnRepoCommunityRaw{Repo: repo, Contributors: []CommunityContributor{}, Merged: []CommunityPRSample{}, Issues: []CommunityIssueSample{}}
	response, err := c.request(ctx, http.MethodGet, c.baseURL+"/repos/"+repo+"/contributors?per_page=100", nil, nil)
	if err != nil {
		return raw, fmt.Errorf("GitHub contributors: %w", ErrGitHubUnavailable)
	}
	remainingHeader := response.Header.Get("X-RateLimit-Remaining")
	remaining, parseErr := strconv.ParseFloat(remainingHeader, 64)
	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests {
		response.Body.Close()
		if parseErr == nil && remaining == 0 {
			return raw, ErrGitHubRateLimited
		}
		return raw, fmt.Errorf("GitHub contributors HTTP %d: %w", response.StatusCode, ErrGitHubUnavailable)
	}
	if remainingHeader != "" && parseErr == nil && remaining < communityRESTFloor {
		response.Body.Close()
		return raw, errCommunityBudget
	}
	if response.StatusCode >= 200 && response.StatusCode <= 299 {
		var list []struct {
			Login         *string `json:"login"`
			Type          *string `json:"type"`
			Contributions float64 `json:"contributions"`
		}
		if json.NewDecoder(response.Body).Decode(&list) == nil {
			for _, contributor := range list {
				if contributor.Login == nil {
					continue
				}
				typ := "User"
				if contributor.Type != nil {
					typ = *contributor.Type
				}
				raw.Contributors = append(raw.Contributors, CommunityContributor{Login: *contributor.Login, Type: typ, Contributions: contributor.Contributions})
			}
		}
	}
	response.Body.Close()

	owner, name, _ := strings.Cut(repo, "/")
	search := func(filter string) string { return "repo:" + repo + " " + filter + " -author:" + login }
	var counts struct {
		RateLimit  *graphRateLimit `json:"rateLimit"`
		Repository *struct {
			ForkCount float64 `json:"forkCount"`
		} `json:"repository"`
		Closed struct {
			IssueCount float64 `json:"issueCount"`
		} `json:"closed"`
		Opened struct {
			IssueCount float64 `json:"issueCount"`
		} `json:"opened"`
	}
	if err := c.communityGraphQL(ctx, `query($o: String!, $n: String!, $c: String!, $p: String!) {
  rateLimit { remaining }
  repository(owner: $o, name: $n) { forkCount }
  closed: search(query: $c, type: ISSUE, first: 0) { issueCount }
  opened: search(query: $p, type: ISSUE, first: 0) { issueCount }
}`, map[string]any{"o": owner, "n": name, "c": search("is:pr is:closed is:unmerged"), "p": search("is:pr")}, &counts); err != nil {
		return raw, err
	}
	if err := checkCommunityGraphQLBudget(counts.RateLimit); err != nil {
		return raw, err
	}
	if counts.Repository != nil {
		raw.Forks = counts.Repository.ForkCount
	}
	raw.ClosedUnmergedTotal, raw.PRsOpenedTotal = counts.Closed.IssueCount, counts.Opened.IssueCount

	var after *string
	for page := 0; page < communityPRSamplePages; page++ {
		var result struct {
			Search struct {
				IssueCount float64 `json:"issueCount"`
				PageInfo   struct {
					HasNextPage bool    `json:"hasNextPage"`
					EndCursor   *string `json:"endCursor"`
				} `json:"pageInfo"`
				Nodes []*struct {
					CreatedAt *string `json:"createdAt"`
					MergedAt  *string `json:"mergedAt"`
					Additions float64 `json:"additions"`
					Deletions float64 `json:"deletions"`
					Title     *string `json:"title"`
					Files     *struct {
						Nodes []struct {
							Path string `json:"path"`
						} `json:"nodes"`
					} `json:"files"`
					Author *communityAuthorNode `json:"author"`
				} `json:"nodes"`
			} `json:"search"`
		}
		query := `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ` + strconv.Itoa(communityPRPage) + `, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      createdAt mergedAt additions deletions title
      files(first: 15) { nodes { path } }
      author { __typename login }
    } }
  }
}`
		if err := c.communityGraphQL(ctx, query, map[string]any{"q": search("is:pr is:merged sort:created-desc"), "after": after}, &result); err != nil {
			return raw, err
		}
		raw.MergedTotal = result.Search.IssueCount
		for _, node := range result.Search.Nodes {
			if node == nil || node.CreatedAt == nil || node.MergedAt == nil {
				continue
			}
			sample := CommunityPRSample{CreatedAt: *node.CreatedAt, MergedAt: *node.MergedAt, Title: node.Title, Churn: node.Additions + node.Deletions, Files: []string{}}
			if node.Author != nil {
				sample.Author, sample.AuthorType = node.Author.Login, node.Author.Typename
			}
			if node.Files != nil {
				for _, file := range node.Files.Nodes {
					sample.Files = append(sample.Files, file.Path)
				}
			}
			raw.Merged = append(raw.Merged, sample)
		}
		if !result.Search.PageInfo.HasNextPage || result.Search.PageInfo.EndCursor == nil {
			break
		}
		after = result.Search.PageInfo.EndCursor
	}

	var issues struct {
		Search struct {
			IssueCount float64 `json:"issueCount"`
			Nodes      []*struct {
				CreatedAt *string              `json:"createdAt"`
				Author    *communityAuthorNode `json:"author"`
				Comments  *struct {
					Nodes []*struct {
						Author *struct {
							Login string `json:"login"`
						} `json:"author"`
					} `json:"nodes"`
				} `json:"comments"`
			} `json:"nodes"`
		} `json:"search"`
	}
	if err := c.communityGraphQL(ctx, `query($q: String!) {
  search(query: $q, type: ISSUE, first: `+strconv.Itoa(communityIssueSample)+`) {
    issueCount
    nodes { ... on Issue {
      createdAt
      author { __typename login }
      comments(first: 5) { nodes { author { login } } }
    } }
  }
}`, map[string]any{"q": search("is:issue sort:created-desc")}, &issues); err != nil {
		return raw, err
	}
	raw.IssuesTotal = issues.Search.IssueCount
	for _, node := range issues.Search.Nodes {
		if node == nil || node.CreatedAt == nil {
			continue
		}
		sample := CommunityIssueSample{CreatedAt: *node.CreatedAt, Commenters: []string{}}
		if node.Author != nil {
			sample.Author, sample.AuthorType = node.Author.Login, node.Author.Typename
		}
		if node.Comments != nil {
			for _, comment := range node.Comments.Nodes {
				if comment != nil && comment.Author != nil {
					sample.Commenters = append(sample.Commenters, comment.Author.Login)
				}
			}
		}
		raw.Issues = append(raw.Issues, sample)
	}
	return raw, nil
}

type communityProfileNode struct {
	Login     string  `json:"login"`
	CreatedAt *string `json:"createdAt"`
	Followers *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"followers"`
	PullRequests *struct {
		TotalCount float64 `json:"totalCount"`
	} `json:"pullRequests"`
	Organizations *struct {
		Nodes []*struct {
			Login string `json:"login"`
		} `json:"nodes"`
	} `json:"organizations"`
}

func (c *GitHubClient) fetchCommunityProfiles(ctx context.Context, logins []string, cache CollectCache) (map[string]CommunityProfile, error) {
	profiles := map[string]CommunityProfile{}
	missing := []string{}
	for _, login := range logins {
		var cached CommunityProfile
		if cacheGetJSON(ctx, cache, "community:profile:"+communityCacheVersion+":"+login, &cached) {
			profiles[login] = cached
		} else {
			missing = append(missing, login)
		}
	}
	var mu sync.Mutex
	var rateLimited error
	semaphore := make(chan struct{}, communityProfileConcurrency)
	var wait sync.WaitGroup
	for start := 0; start < len(missing); start += communityProfileBatch {
		end := start + communityProfileBatch
		if end > len(missing) {
			end = len(missing)
		}
		batch := missing[start:end]
		wait.Add(1)
		semaphore <- struct{}{}
		go func(batch []string) {
			defer wait.Done()
			defer func() { <-semaphore }()
			declarations, aliases := []string{}, []string{}
			variables := map[string]any{}
			for index, login := range batch {
				declarations = append(declarations, fmt.Sprintf("$l%d: String!", index))
				aliases = append(aliases, fmt.Sprintf("u%d: user(login: $l%d) { login createdAt followers { totalCount } pullRequests(states: MERGED) { totalCount } organizations(first: 10) { nodes { login } } }", index, index))
				variables[fmt.Sprintf("l%d", index)] = login
			}
			query := "query(" + strings.Join(declarations, ", ") + ") { " + strings.Join(aliases, " ") + " }"
			var result map[string]*communityProfileNode
			var err error
			for attempt := 0; attempt < 3; attempt++ {
				result = nil
				if err = c.graphqlAllowNotFound(ctx, query, variables, &result); err == nil || errors.Is(err, ErrGitHubRateLimited) {
					break
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Duration(attempt+1) * time.Second):
				}
			}
			if errors.Is(err, ErrGitHubRateLimited) {
				mu.Lock()
				rateLimited = err
				mu.Unlock()
				return
			}
			for index, login := range batch {
				node := result[fmt.Sprintf("u%d", index)]
				if node == nil {
					continue
				}
				profile := CommunityProfile{Login: login, CreatedAt: node.CreatedAt, Orgs: []string{}}
				if node.Followers != nil {
					profile.Followers = node.Followers.TotalCount
				}
				if node.PullRequests != nil {
					profile.MergedPRs = node.PullRequests.TotalCount
				}
				if node.Organizations != nil {
					for _, org := range node.Organizations.Nodes {
						if org != nil {
							profile.Orgs = append(profile.Orgs, strings.ToLower(org.Login))
						}
					}
				}
				sort.Strings(profile.Orgs)
				mu.Lock()
				profiles[login] = profile
				mu.Unlock()
				cacheSetJSON(ctx, cache, "community:profile:"+communityCacheVersion+":"+login, profile, communityProfileTTL)
			}
		}(batch)
	}
	wait.Wait()
	if rateLimited != nil {
		return nil, rateLimited
	}
	return profiles, nil
}

// collectOwnRepoCommunities mirrors collectOwnRepoCommunities in
// src/lib/github.ts: the top three own repos by outside merged PRs, facts
// cached 7 days, counts 1 day, profiles 30 days. Best-effort: only a GitHub
// rate limit fails the scan.
func (c *GitHubClient) collectOwnRepoCommunities(ctx context.Context, repos []ContribRepoAgg, login string, ownerOrgs []string, now time.Time, cache CollectCache) (map[string]OwnRepoCommunityFacts, error) {
	loginLower := strings.ToLower(login)
	facts := map[string]OwnRepoCommunityFacts{}
	candidates := CommunityCandidates(repos, loginLower)
	if len(candidates) == 0 {
		return facts, nil
	}
	counts, err := c.fetchCommunityCounts(ctx, candidates, login, cache)
	if err != nil {
		if errors.Is(err, ErrGitHubRateLimited) {
			return nil, err
		}
		return facts, nil
	}
	picked := []ContribRepoAgg{}
	for _, repo := range candidates {
		if counts[strings.ToLower(repo.Repo)] > 0 {
			picked = append(picked, repo)
		}
	}
	sort.SliceStable(picked, func(i, j int) bool {
		ci, cj := counts[strings.ToLower(picked[i].Repo)], counts[strings.ToLower(picked[j].Repo)]
		if ci != cj {
			return ci > cj
		}
		if picked[i].Stars != picked[j].Stars {
			return picked[i].Stars > picked[j].Stars
		}
		return picked[i].Repo < picked[j].Repo
	})
	if len(picked) > communityRepoCap {
		picked = picked[:communityRepoCap]
	}
	mutualOwners := contributedRepoOwners(repos, loginLower)
	lowerOrgs := make([]string, 0, len(ownerOrgs))
	for _, org := range ownerOrgs {
		lowerOrgs = append(lowerOrgs, strings.ToLower(org))
	}
	factsKey := func(repo ContribRepoAgg) string {
		return "community:facts:" + communityCacheVersion + ":" + loginLower + ":" + strings.ToLower(repo.Repo)
	}
	uncached := []ContribRepoAgg{}
	for _, repo := range picked {
		var cached OwnRepoCommunityFacts
		if cacheGetJSON(ctx, cache, factsKey(repo), &cached) {
			facts[strings.ToLower(repo.Repo)] = cached
		} else {
			uncached = append(uncached, repo)
		}
	}
	raws := make([]*OwnRepoCommunityRaw, len(uncached))
	errs := make([]error, len(uncached))
	var wait sync.WaitGroup
	for index, repo := range uncached {
		wait.Add(1)
		go func(index int, repo ContribRepoAgg) {
			defer wait.Done()
			raw, err := c.fetchOwnRepoCommunityRaw(ctx, repo.Repo, login)
			if err != nil {
				errs[index] = err
				return
			}
			raws[index] = &raw
		}(index, repo)
	}
	wait.Wait()
	for _, err := range errs {
		if errors.Is(err, ErrGitHubRateLimited) {
			return nil, err
		}
		if errors.Is(err, errCommunityBudget) {
			return facts, nil
		}
	}
	loginSet := map[string]bool{}
	for _, raw := range raws {
		if raw == nil {
			continue
		}
		for _, contributor := range raw.Contributors {
			login, typ := contributor.Login, contributor.Type
			if !isCommunityBot(&login, &typ) {
				loginSet[strings.ToLower(login)] = true
			}
		}
		for _, pr := range raw.Merged {
			if !isCommunityBot(pr.Author, pr.AuthorType) {
				loginSet[strings.ToLower(*pr.Author)] = true
			}
		}
		for _, issue := range raw.Issues {
			if !isCommunityBot(issue.Author, issue.AuthorType) {
				loginSet[strings.ToLower(*issue.Author)] = true
			}
		}
	}
	delete(loginSet, loginLower)
	logins := make([]string, 0, len(loginSet))
	for login := range loginSet {
		logins = append(logins, login)
	}
	sort.Strings(logins)
	profiles := map[string]CommunityProfile{}
	if len(logins) > 0 {
		if profiles, err = c.fetchCommunityProfiles(ctx, logins, cache); err != nil {
			return nil, err
		}
	}
	nowISO := now.UTC().Format("2006-01-02T15:04:05.000Z")
	for index, repo := range uncached {
		raw := raws[index]
		if raw == nil {
			continue
		}
		repoFacts := ComputeOwnRepoCommunityFacts(*raw, OwnRepoCommunityContext{Login: login, OwnerOrgs: lowerOrgs, Attributed: repo.AttributedOriginal, MutualOwners: mutualOwners, Profiles: profiles, Now: nowISO})
		facts[strings.ToLower(repo.Repo)] = repoFacts
		cacheSetJSON(ctx, cache, factsKey(repo), repoFacts, communityFactsTTL)
	}
	return facts, nil
}
