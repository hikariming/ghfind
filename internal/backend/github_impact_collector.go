package backend

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

const impactYearCap = 6

type graphContributionRepo struct {
	NameWithOwner  string  `json:"nameWithOwner"`
	StargazerCount float64 `json:"stargazerCount"`
	IsPrivate      bool    `json:"isPrivate"`
	IsFork         bool    `json:"isFork"`
	Owner          *struct {
		Login *string `json:"login"`
	} `json:"owner"`
}

type graphCommitContribNode struct {
	Contributions *struct {
		TotalCount float64 `json:"totalCount"`
		Nodes      []*struct {
			OccurredAt *string `json:"occurredAt"`
		} `json:"nodes"`
	} `json:"contributions"`
	Repository *graphContributionRepo `json:"repository"`
}

func contributionRepoFromGraph(repo *graphContributionRepo) ContribRepoAgg {
	if repo == nil {
		return ContribRepoAgg{}
	}
	owner := ownerLoginFromRepo(repo.NameWithOwner)
	if repo.Owner != nil && repo.Owner.Login != nil && *repo.Owner.Login != "" {
		owner = *repo.Owner.Login
	}
	return ContribRepoAgg{Repo: repo.NameWithOwner, Stars: repo.StargazerCount, IsPrivate: repo.IsPrivate, IsFork: repo.IsFork, OwnerLogin: owner}
}

// fetchCommitContribReposByYear mirrors the Node collector's bounded GraphQL
// aliases. GraphQL permits each contribution window to cover only one year.
func (c *GitHubClient) fetchCommitContribReposByYear(ctx context.Context, username string, years []int, scopes ...*collectionScope) ([]ContribRepoAgg, error) {
	scope := sourceScope(scopes)
	unique := map[int]bool{}
	for _, year := range years {
		unique[year] = true
	}
	capped := make([]int, 0, len(unique))
	for year := range unique {
		capped = append(capped, year)
	}
	sort.Slice(capped, func(i, j int) bool { return capped[i] > capped[j] })
	if !scope.Full && len(capped) > impactYearCap {
		scope.note("commit_year_cap")
		capped = capped[:impactYearCap]
	}
	if len(capped) == 0 {
		return nil, nil
	}
	perYear, err := c.fetchCommitContribsBatch(ctx, username, capped)
	completedYears := map[int]bool{}
	recoverResourceLimitedYear := func(year int) ([]graphCommitContribNode, error) {
		// Quick mode notes and escalates. Full mode subdivides silently on success;
		// note commit_resource_limit only when the year still cannot be recovered.
		if !scope.Full {
			scope.note("commit_resource_limit")
			return nil, nil
		}
		from := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
		to := time.Date(year+1, 1, 1, 0, 0, 0, 0, time.UTC).Add(-time.Second)
		nodes, e := c.fetchCompleteCommitWindow(ctx, username, from, to)
		if errors.Is(e, ErrGitHubResourceLimit) {
			scope.note("commit_resource_limit")
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		completedYears[year] = true
		return nodes, nil
	}
	if errors.Is(err, ErrGitHubResourceLimit) {
		// Quick mode notes and skips; full mode subdivides via fetchCompleteCommitWindow
		// so a pathological year is not silently dropped (mirrors Node collector).
		perYear = make([][]graphCommitContribNode, len(capped))
		for index, year := range capped {
			var singleErr error
			var single [][]graphCommitContribNode
			if len(capped) == 1 {
				singleErr = err
			} else {
				single, singleErr = c.fetchCommitContribsBatch(ctx, username, []int{year})
			}
			if errors.Is(singleErr, ErrGitHubResourceLimit) {
				nodes, e := recoverResourceLimitedYear(year)
				if e != nil {
					return nil, e
				}
				perYear[index] = nodes
				continue
			}
			if singleErr != nil {
				return nil, singleErr
			}
			perYear[index] = single[0]
		}
	} else if err != nil {
		return nil, err
	}

	byRepo := map[string]ContribRepoAgg{}
	yearsByRepo := map[string]map[int]bool{}
	monthsByRepo := map[string]map[string]bool{}
	order := []string{}
	for index, nodes := range perYear {
		if !completedYears[capped[index]] && len(nodes) >= githubPageSize {
			if scope.Full {
				from := time.Date(capped[index], 1, 1, 0, 0, 0, 0, time.UTC)
				to := time.Date(capped[index]+1, 1, 1, 0, 0, 0, 0, time.UTC).Add(-time.Second)
				var e error
				nodes, e = c.fetchCompleteCommitWindow(ctx, username, from, to)
				if e != nil {
					return nil, e
				}
				completedYears[capped[index]] = true
			} else {
				scope.note("commit_repository_cap")
			}
		}
		for _, node := range nodes {
			if node.Repository == nil || node.Repository.NameWithOwner == "" {
				continue
			}
			key := node.Repository.NameWithOwner
			current, found := byRepo[key]
			if !found {
				current = contributionRepoFromGraph(node.Repository)
				order = append(order, key)
			}
			current.Stars = max(current.Stars, node.Repository.StargazerCount)
			if node.Contributions != nil {
				current.Commits += node.Contributions.TotalCount
				for _, contribution := range node.Contributions.Nodes {
					if contribution != nil {
						addMonth(monthsByRepo, key, contribution.OccurredAt)
					}
				}
			}
			byRepo[key] = current
			if yearsByRepo[key] == nil {
				yearsByRepo[key] = map[int]bool{}
			}
			yearsByRepo[key][capped[index]] = true
		}
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		current := byRepo[key]
		current.ActiveYears = float64(len(yearsByRepo[key]))
		current.Months = sortedMonths(monthsByRepo[key])
		result = append(result, current)
	}
	return result, nil
}

// addMonth records the "YYYY-MM" (UTC) month of a GitHub timestamp.
func addMonth(monthsByRepo map[string]map[string]bool, key string, timestamp *string) {
	parsed, ok := parseTimestamp(timestamp)
	if !ok {
		return
	}
	if monthsByRepo[key] == nil {
		monthsByRepo[key] = map[string]bool{}
	}
	monthsByRepo[key][parsed.UTC().Format("2006-01")] = true
}

func sortedMonths(months map[string]bool) []string {
	result := make([]string, 0, len(months))
	for month := range months {
		result = append(result, month)
	}
	sort.Strings(result)
	return result
}

func (c *GitHubClient) fetchCommitContribsBatch(ctx context.Context, username string, years []int, windows ...[2]string) ([][]graphCommitContribNode, error) {
	declarations := []string{"$login: String!"}
	aliases := []string{}
	variables := map[string]any{"login": username}
	for index, year := range years {
		declarations = append(declarations, fmt.Sprintf("$from%d: DateTime!, $to%d: DateTime!", index, index))
		aliases = append(aliases, fmt.Sprintf("y%d: contributionsCollection(from: $from%d, to: $to%d) { ...RepoContribs }", index, index, index))
		variables[fmt.Sprintf("from%d", index)] = fmt.Sprintf("%d-01-01T00:00:00Z", year)
		variables[fmt.Sprintf("to%d", index)] = fmt.Sprintf("%d-12-31T23:59:59Z", year)
		if len(windows) > index {
			variables[fmt.Sprintf("from%d", index)] = windows[index][0]
			variables[fmt.Sprintf("to%d", index)] = windows[index][1]
		}
	}
	query := "query(" + strings.Join(declarations, ", ") + `) {
  user(login: $login) { ` + strings.Join(aliases, " ") + ` }
}
fragment RepoContribs on ContributionsCollection {
  commitContributionsByRepository(maxRepositories: 100) {
    contributions(first: 100) { totalCount nodes { occurredAt } }
    repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
  }
}`
	var result struct {
		User map[string]struct {
			CommitContributionsByRepository []graphCommitContribNode `json:"commitContributionsByRepository"`
		} `json:"user"`
	}
	if err := c.graphql(ctx, query, variables, &result); err != nil {
		return nil, err
	}
	if result.User == nil {
		return nil, fmt.Errorf("GitHub commit contributions: %w", ErrGitHubUnavailable)
	}
	pages := make([][]graphCommitContribNode, len(years))
	for index := range years {
		pages[index] = result.User[fmt.Sprintf("y%d", index)].CommitContributionsByRepository
	}
	return pages, nil
}

const (
	// impactSignalRepoCap bounds the repos (by stars) whose topics and merge
	// share are fetched; mergeCommitSample is the per-repo commit sample.
	impactSignalRepoCap = 20
	mergeCommitSample   = 100
)

type ImpactRepoSignal struct {
	Topics         []string
	SampledCommits float64
	MergeCommits   float64
	// Engagement is nil when the repo's community engagement is not measurable.
	Engagement *float64
}

// ApplyImpactRepoSignals mirrors applyImpactRepoSignals in src/lib/github.ts:
// the sampled merge share is applied to the contribution-graph total.
func ApplyImpactRepoSignals(repos []ContribRepoAgg, signals map[string]ImpactRepoSignal) []ContribRepoAgg {
	result := make([]ContribRepoAgg, 0, len(repos))
	for _, repo := range repos {
		if signal, ok := signals[strings.ToLower(repo.Repo)]; ok {
			share := 0.0
			if signal.SampledCommits > 0 {
				share = signal.MergeCommits / signal.SampledCommits
			}
			repo.Topics = signal.Topics
			repo.MergeCommits = roundJS(repo.Commits * share)
			if signal.Engagement != nil {
				repo.Engagement = signal.Engagement
			}
		}
		result = append(result, repo)
	}
	return result
}

// fetchImpactRepoSignals mirrors the Node collector: one aliased GraphQL
// request with topics and the user's latest default-branch commits (with
// parent counts) for repos that can earn ecosystem impact. Best-effort: only a
// rate limit fails the scan; other errors leave impact on name-only rules.
func (c *GitHubClient) fetchImpactRepoSignals(ctx context.Context, repos []ContribRepoAgg, loginLower, authorNodeID string) (map[string]ImpactRepoSignal, error) {
	signals := map[string]ImpactRepoSignal{}
	candidates := []ContribRepoAgg{}
	for _, repo := range repos {
		if passesImpactRepoGates(repo, loginLower) && strings.Contains(repo.Repo, "/") {
			candidates = append(candidates, repo)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Stars != candidates[j].Stars {
			return candidates[i].Stars > candidates[j].Stars
		}
		return candidates[i].Repo < candidates[j].Repo
	})
	if len(candidates) > impactSignalRepoCap {
		candidates = candidates[:impactSignalRepoCap]
	}
	if authorNodeID == "" || len(candidates) == 0 {
		return signals, nil
	}
	declarations := []string{"$author: ID!"}
	aliases := []string{}
	variables := map[string]any{"author": authorNodeID}
	for index, repo := range candidates {
		owner, name, _ := strings.Cut(repo.Repo, "/")
		declarations = append(declarations, fmt.Sprintf("$o%d: String!, $n%d: String!", index, index))
		aliases = append(aliases, fmt.Sprintf("r%d: repository(owner: $o%d, name: $n%d) { ...ImpactRepoSignals }", index, index, index))
		variables[fmt.Sprintf("o%d", index)] = owner
		variables[fmt.Sprintf("n%d", index)] = name
	}
	query := "query(" + strings.Join(declarations, ", ") + ") { " + strings.Join(aliases, " ") + ` }
fragment ImpactRepoSignals on Repository {
  repositoryTopics(first: 20) { nodes { topic { name } } }
  stargazerCount hasIssuesEnabled isMirror
  watchers { totalCount } issues { totalCount } pullRequests { totalCount }
  defaultBranchRef { target { ... on Commit {
    history(first: ` + fmt.Sprint(mergeCommitSample) + `, author: { id: $author }) { nodes { parents(first: 2) { totalCount } } }
  } } }
}`
	var result map[string]*struct {
		repoEngagementFields
		RepositoryTopics *struct {
			Nodes []*struct {
				Topic *struct {
					Name string `json:"name"`
				} `json:"topic"`
			} `json:"nodes"`
		} `json:"repositoryTopics"`
		DefaultBranchRef *struct {
			Target *struct {
				History *struct {
					Nodes []*struct {
						Parents *struct {
							TotalCount float64 `json:"totalCount"`
						} `json:"parents"`
					} `json:"nodes"`
				} `json:"history"`
			} `json:"target"`
		} `json:"defaultBranchRef"`
	}
	if err := c.graphql(ctx, query, variables, &result); err != nil {
		if errors.Is(err, ErrGitHubRateLimited) {
			return nil, err
		}
		return signals, nil
	}
	for index, repo := range candidates {
		node := result[fmt.Sprintf("r%d", index)]
		if node == nil {
			continue
		}
		signal := ImpactRepoSignal{Topics: []string{}, Engagement: node.repoEngagementFields.ratio()}
		if node.RepositoryTopics != nil {
			for _, topic := range node.RepositoryTopics.Nodes {
				if topic != nil && topic.Topic != nil {
					signal.Topics = append(signal.Topics, topic.Topic.Name)
				}
			}
		}
		if node.DefaultBranchRef != nil && node.DefaultBranchRef.Target != nil && node.DefaultBranchRef.Target.History != nil {
			for _, commit := range node.DefaultBranchRef.Target.History.Nodes {
				signal.SampledCommits++
				if commit != nil && commit.Parents != nil && commit.Parents.TotalCount > 1 {
					signal.MergeCommits++
				}
			}
		}
		signals[strings.ToLower(repo.Repo)] = signal
	}
	return signals, nil
}

type mergedPRNode struct {
	ID         *string                `json:"id"`
	MergedAt   *string                `json:"mergedAt"`
	Repository *graphContributionRepo `json:"repository"`
}

type graphPageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

// fetchMergedPRNodes returns the newest merged PRs (all repos), up to maxPRs.
func (c *GitHubClient) fetchMergedPRNodes(ctx context.Context, username string, maxPRs int) ([]mergedPRNode, error) {
	return c.fetchMergedPRNodesSince(ctx, username, maxPRs, "")
}

// fetchMergedPRNodesSince reads the existing merged window. since is ignored:
// this connection is ordered by CREATED_AT, while the watermark is mergedAt.
// Stopping early would miss a PR created before the watermark and merged after it.
func (c *GitHubClient) fetchMergedPRNodesSince(ctx context.Context, username string, maxPRs int, since string) ([]mergedPRNode, error) {
	_ = since
	nodes := []mergedPRNode{}
	var after *string
	for len(nodes) < maxPRs {
		count := maxPRs - len(nodes)
		if count > 100 {
			count = 100
		}
		var result struct {
			User *struct {
				PullRequests *struct {
					Nodes    []mergedPRNode `json:"nodes"`
					PageInfo *graphPageInfo `json:"pageInfo"`
				} `json:"pullRequests"`
			} `json:"user"`
		}
		query := `query($login: String!, $count: Int!, $after: String) {
  user(login: $login) {
    pullRequests(first: $count, states: MERGED, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { id mergedAt repository { nameWithOwner stargazerCount isPrivate isFork owner { login } } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`
		if err := c.graphql(ctx, query, map[string]any{"login": username, "count": count, "after": after}, &result); err != nil {
			return nil, err
		}
		if result.User == nil || result.User.PullRequests == nil {
			return nil, fmt.Errorf("GitHub merged PR data: %w", ErrGitHubUnavailable)
		}
		page := result.User.PullRequests
		nodes = append(nodes, page.Nodes...)
		if page.PageInfo == nil {
			return nil, ErrGitHubUnavailable
		}
		if !page.PageInfo.HasNextPage {
			break
		}
		if page.PageInfo.EndCursor == nil || *page.PageInfo.EndCursor == "" || len(page.Nodes) == 0 || (after != nil && *after == *page.PageInfo.EndCursor) {
			return nil, ErrGitHubUnavailable
		}
		after = page.PageInfo.EndCursor
	}
	return nodes, nil
}

// externalMergedPRCap bounds the external merged PRs fetched per scan.
const externalMergedPRCap = 300

type externalMergedPRs struct {
	Total float64
	Nodes []mergedPRNode
}

// fetchExternalMergedPRs mirrors fetchExternalMergedPrs: public merged PRs
// into repos the user does not own, so own-repo PR traffic cannot crowd older
// external work out of the newest-300 window. Best-effort: only a rate limit
// fails the scan; other errors return nil (single-pool contribution volume).
func (c *GitHubClient) fetchExternalMergedPRs(ctx context.Context, username string, maxPRs int) (*externalMergedPRs, error) {
	return c.fetchExternalMergedPRsSince(ctx, username, maxPRs, "")
}

// fetchExternalMergedPRsSince reads the existing search window. since is
// ignored: search is ordered by created time, not mergedAt, and still pages
// from the start. Stopping on mergedAt would miss a late merge of an older PR.
func (c *GitHubClient) fetchExternalMergedPRsSince(ctx context.Context, username string, maxPRs int, since string) (*externalMergedPRs, error) {
	_ = since
	search := "is:pr is:merged is:public author:" + username + " -user:" + username + " sort:created-desc"
	result := &externalMergedPRs{Nodes: []mergedPRNode{}}
	var after *string
	for len(result.Nodes) < maxPRs {
		count := maxPRs - len(result.Nodes)
		if count > 100 {
			count = 100
		}
		var page struct {
			Search *struct {
				IssueCount float64        `json:"issueCount"`
				Nodes      []mergedPRNode `json:"nodes"`
				PageInfo   *graphPageInfo `json:"pageInfo"`
			} `json:"search"`
		}
		query := `query($q: String!, $count: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $count, after: $after) {
    issueCount
    nodes { ... on PullRequest { id mergedAt repository { nameWithOwner stargazerCount isPrivate isFork owner { login } } } }
    pageInfo { hasNextPage endCursor }
  }
}`
		if err := c.graphql(ctx, query, map[string]any{"q": search, "count": count, "after": after}, &page); err != nil {
			if errors.Is(err, ErrGitHubRateLimited) {
				return nil, err
			}
			return nil, nil
		}
		if page.Search == nil {
			break
		}
		result.Total = page.Search.IssueCount
		kept := 0
		for _, node := range page.Search.Nodes {
			if node.Repository == nil {
				continue
			}
			result.Nodes = append(result.Nodes, node)
			kept++
		}
		info := page.Search.PageInfo
		if info == nil || !info.HasNextPage || info.EndCursor == nil || *info.EndCursor == "" || kept == 0 {
			break
		}
		after = info.EndCursor
	}
	result.Total = max(result.Total, float64(len(result.Nodes)))
	return result, nil
}

// AggregateMergedPRNodes mirrors aggregateMergedPrNodes: per-repo merged-PR
// aggregates from PR nodes, deduplicated by PR id.
func AggregateMergedPRNodes(nodes []mergedPRNode) []ContribRepoAgg {
	byRepo := map[string]ContribRepoAgg{}
	yearsByRepo := map[string]map[int]bool{}
	monthsByRepo := map[string]map[string]bool{}
	seen := map[string]bool{}
	order := []string{}
	for _, node := range nodes {
		if node.Repository == nil {
			continue
		}
		if node.ID != nil && *node.ID != "" {
			if seen[*node.ID] {
				continue
			}
			seen[*node.ID] = true
		}
		key := node.Repository.NameWithOwner
		current, found := byRepo[key]
		if !found {
			current = contributionRepoFromGraph(node.Repository)
			order = append(order, key)
		}
		current.Stars = max(current.Stars, node.Repository.StargazerCount)
		current.PRs++
		byRepo[key] = current
		if merged, ok := parseTimestamp(node.MergedAt); ok {
			if yearsByRepo[key] == nil {
				yearsByRepo[key] = map[int]bool{}
			}
			yearsByRepo[key][merged.UTC().Year()] = true
		}
		addMonth(monthsByRepo, key, node.MergedAt)
	}
	result := make([]ContribRepoAgg, 0, len(order))
	for _, key := range order {
		current := byRepo[key]
		current.ActiveYears = float64(len(yearsByRepo[key]))
		current.Months = sortedMonths(monthsByRepo[key])
		result = append(result, current)
	}
	return result
}

// highStarPRShare mirrors highStarPrShare: share of PR nodes into >=200-star
// repos, 1 when there are none.
func highStarPRShare(nodes []mergedPRNode) float64 {
	if len(nodes) == 0 {
		return 1
	}
	high := 0.0
	for _, node := range nodes {
		if node.Repository != nil && node.Repository.StargazerCount >= 200 {
			high++
		}
	}
	return roundJS(high/float64(len(nodes))*10000) / 10000
}

const (
	// impactCodeSampleSize merged PRs per repo are file-classified;
	// impactCodeSampleRepoCap repos (by stars) may have their sample fetched.
	impactCodeSampleSize    = 10
	impactCodeSampleRepoCap = 12
)

type ImpactCodeSample struct {
	PRSample     float64
	CodePRSample float64
}

// impactCodeSample mirrors impactCodeSample: classify up to ten merged PRs.
func impactCodeSample(prs []RecentPR) ImpactCodeSample {
	if len(prs) > impactCodeSampleSize {
		prs = prs[:impactCodeSampleSize]
	}
	sample := ImpactCodeSample{PRSample: float64(len(prs))}
	for _, pr := range prs {
		if share, ok := prPresentationShare(pr); ok {
			sample.CodePRSample += 1 - share
		} else if !IsDocLikeImpactPR(pr) {
			sample.CodePRSample++
		}
	}
	return sample
}

// ApplyImpactCodeSamples mirrors applyImpactCodeSamples.
func ApplyImpactCodeSamples(repos []ContribRepoAgg, samples map[string]ImpactCodeSample) []ContribRepoAgg {
	result := make([]ContribRepoAgg, 0, len(repos))
	for _, repo := range repos {
		if sample, ok := samples[strings.ToLower(repo.Repo)]; ok && sample.PRSample > 0 {
			repo.PRSample, repo.CodePRSample = sample.PRSample, sample.CodePRSample
		}
		result = append(result, repo)
	}
	return result
}

// collectImpactCodeSamples mirrors collectImpactCodeSamples: the recent PR
// window first, then one aliased GraphQL search for the top under-covered
// impact repos. Best-effort: only a rate limit fails the scan.
func (c *GitHubClient) collectImpactCodeSamples(ctx context.Context, repos []ContribRepoAgg, login string, window []RecentPR) (map[string]ImpactCodeSample, error) {
	loginLower := strings.ToLower(login)
	windowByRepo := map[string][]RecentPR{}
	for _, pr := range window {
		if pr.Repo == nil {
			continue
		}
		key := strings.ToLower(*pr.Repo)
		windowByRepo[key] = append(windowByRepo[key], pr)
	}
	samples := map[string]ImpactCodeSample{}
	for key, prs := range windowByRepo {
		samples[key] = impactCodeSample(prs)
	}
	ranked := []ContribRepoAgg{}
	for _, repo := range repos {
		if repo.PRs > 0 && strings.Contains(repo.Repo, "/") && passesImpactRepoGates(repo, loginLower) && (repo.Stars >= docResourceImpactMinStars || !isDocOrResourceRepo(repo)) {
			ranked = append(ranked, repo)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].Stars != ranked[j].Stars {
			return ranked[i].Stars > ranked[j].Stars
		}
		return ranked[i].Repo < ranked[j].Repo
	})
	if len(ranked) > impactCodeSampleRepoCap {
		ranked = ranked[:impactCodeSampleRepoCap]
	}
	candidates := []ContribRepoAgg{}
	for _, repo := range ranked {
		if float64(len(windowByRepo[strings.ToLower(repo.Repo)])) < min(impactCodeSampleSize, repo.PRs) {
			candidates = append(candidates, repo)
		}
	}
	if len(candidates) == 0 {
		return samples, nil
	}
	declarations, aliases := []string{}, []string{}
	variables := map[string]any{}
	for index, repo := range candidates {
		declarations = append(declarations, fmt.Sprintf("$q%d: String!", index))
		aliases = append(aliases, fmt.Sprintf("s%d: search(query: $q%d, type: ISSUE, first: %d) { nodes { ...CodeSamplePr } }", index, index, impactCodeSampleSize))
		variables[fmt.Sprintf("q%d", index)] = "repo:" + repo.Repo + " is:pr is:merged author:" + login + " sort:created-desc"
	}
	query := "query(" + strings.Join(declarations, ", ") + ") { " + strings.Join(aliases, " ") + ` }
fragment CodeSamplePr on PullRequest {
  title additions deletions changedFiles
  repository { nameWithOwner stargazerCount isPrivate }
  files(first: 100) { nodes { path additions deletions } }
}`
	var result map[string]*struct {
		Nodes []graphPRNode `json:"nodes"`
	}
	if err := c.graphql(ctx, query, variables, &result); err != nil {
		if errors.Is(err, ErrGitHubRateLimited) {
			return nil, err
		}
		return samples, nil
	}
	for index, repo := range candidates {
		node := result[fmt.Sprintf("s%d", index)]
		if node == nil {
			continue
		}
		prs := []RecentPR{}
		for _, pr := range node.Nodes {
			if pr.Repository != nil {
				prs = append(prs, mapRecentPR(pr))
			}
		}
		if len(prs) > 0 {
			samples[strings.ToLower(repo.Repo)] = impactCodeSample(prs)
		}
	}
	return samples, nil
}

// AccountAgeYears matches the two-decimal calculation from src/lib/github.ts.
func accountAgeYears(createdAt *string, now time.Time) float64 {
	created, ok := parseTimestamp(createdAt)
	if !ok {
		return 0
	}
	return roundJS(now.Sub(created).Hours()/24/365.25*100) / 100
}

func boundedContributionYearsActive(years []int, createdAt *string, now time.Time) float64 {
	active := map[int]bool{}
	for _, year := range years {
		active[year] = true
	}
	if len(active) == 0 {
		return 0
	}
	created, ok := parseTimestamp(createdAt)
	if !ok {
		return float64(len(active))
	}
	if now.Year() < created.Year() {
		return 0
	}
	count := 0.0
	for year := range active {
		if year >= created.Year() && year <= now.Year() {
			count++
		}
	}
	return count
}

// GitHub cannot page commitContributionsByRepository. Split only saturated
// time windows, discard their truncated parent, and sum disjoint children.
func (c *GitHubClient) fetchCompleteCommitWindow(ctx context.Context, login string, from, to time.Time) ([]graphCommitContribNode, error) {
	if !to.After(from) {
		return nil, ErrGitHubResourceLimit
	}
	mid := from.Add((to.Sub(from) / time.Second / 2) * time.Second)
	result := []graphCommitContribNode{}
	for _, window := range [][2]time.Time{{from, mid}, {mid.Add(time.Second), to}} {
		if window[0].After(window[1]) {
			continue
		}
		batch, err := c.fetchCommitContribsBatch(ctx, login, []int{from.Year()}, [2]string{window[0].Format(time.RFC3339), window[1].Format(time.RFC3339)})
		if err != nil && !errors.Is(err, ErrGitHubResourceLimit) {
			return nil, err
		}
		var nodes []graphCommitContribNode
		if err == nil {
			nodes = batch[0]
		}
		if err != nil || len(nodes) >= githubPageSize {
			nodes, err = c.fetchCompleteCommitWindow(ctx, login, window[0], window[1])
			if err != nil {
				return nil, err
			}
		}
		result = append(result, nodes...)
	}
	return result, nil
}
